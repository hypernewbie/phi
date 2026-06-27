export class KanbanManager {
    constructor(app) {
        this.app = app;
    }

    async openBoard() {
        const paneId = 'kanban-board';
        const sessionId = 'kanban-board';
        const title = 'Kanban';
        const coder = 'kanban';
        
        // If tab already exists, just switch to it
        if (this.app.tabManager.tabs.has(paneId)) {
            this.app.tabManager.switchTab(paneId);
            return;
        }

        const activeWorkspace = this.app.sessionsManager.activeWorkspace || '';
        const activeCWD = this.app.sessionsManager.activeCWD || '';

        this.app.tabManager.createTab(paneId, sessionId, title, coder, activeWorkspace, activeCWD);
        const tab = this.app.tabManager.tabs.get(paneId);
        if (!tab) return;
        
        this.initTabContainer(tab.termContainer);
    }

    async initTabContainer(container) {
        container.innerHTML = '';
        container.className = 'term-container kanban-panel';
        
        const token = sessionStorage.getItem('vikunja_token');
        if (!token) {
            this.renderLoginForm(container);
        } else {
            await this.loadAndRenderBoard(container);
        }
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
                    <button id="kanban-login-btn" class="btn btn-accent">Connect</button>
                    <div id="kanban-login-error" class="login-error-msg hidden"></div>
                </div>
            </div>
        `;
        
        const loginBtn = container.querySelector('#kanban-login-btn');
        loginBtn.addEventListener('click', async () => {
            const urlInput = container.querySelector('#kanban-url-input').value.trim().replace(/\/$/, '');
            const usernameInput = container.querySelector('#kanban-username-input').value.trim();
            const passwordInput = container.querySelector('#kanban-password-input').value;
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
                const proxyUrl = `/api/proxy?url=${encodeURIComponent(urlInput + '/api/v1/login')}`;
                const res = await fetch(proxyUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: usernameInput, password: passwordInput })
                });
                
                if (!res.ok) {
                    const errText = await res.text();
                    throw new Error(errText || `Login failed with status ${res.status}`);
                }
                
                const data = await res.json();
                if (!data.token) {
                    throw new Error('No token returned from server');
                }
                
                sessionStorage.setItem('vikunja_token', data.token);
                localStorage.setItem('vikunja_url', urlInput);
                localStorage.setItem('vikunja_username', usernameInput);
                
                await this.loadAndRenderBoard(container);
            } catch (err) {
                errorEl.textContent = `Error: ${err.message}`;
                errorEl.classList.remove('hidden');
                loginBtn.disabled = false;
                loginBtn.textContent = 'Connect';
            }
        });
    }

    async loadAndRenderBoard(container) {
        container.innerHTML = `
            <div class="kanban-loading-wrapper">
                <div class="spinner-ring"></div>
                <div class="loader-text">Loading Kanban data...</div>
            </div>
        `;
        
        try {
            // Fetch projects
            const projects = await this.apiGet('/projects');
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
            const views = await this.apiGet(`/projects/${selectedProjectId}/views`);
            const kanbanView = views ? views.find(v => v.view_kind === 'kanban') : null;
            
            if (!kanbanView) {
                this.renderBoardLayout(container, projects, currentProject, null, []);
                return;
            }
            
            // Fetch buckets and tasks
            const bucketsWithTasks = await this.apiGet(`/projects/${selectedProjectId}/views/${kanbanView.id}/tasks`);
            
            this.renderBoardLayout(container, projects, currentProject, kanbanView, bucketsWithTasks);
        } catch (err) {
            console.error('Kanban Load Error:', err);
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
            container.querySelector('#kanban-retry-btn').addEventListener('click', () => this.loadAndRenderBoard(container));
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
                            ${projects.map(p => `<option value="${p.id}" ${p.id == currentProject.id ? 'selected' : ''}>${p.title}</option>`).join('')}
                        </select>
                        <button id="kanban-refresh-btn" class="toolbar-btn" title="Refresh Board">
                            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <polyline points="23 4 23 10 17 10"></polyline>
                                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
                            </svg>
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
        
        container.querySelector('#kanban-disconnect-btn').addEventListener('click', () => {
            sessionStorage.removeItem('vikunja_token');
            this.initTabContainer(container);
        });
        
        // Initialize Sortable if buckets are rendered
        if (kanbanView && bucketsWithTasks && bucketsWithTasks.length > 0) {
            this.initSortable(container, bucketsWithTasks);
        }
    }

    renderColumn(bucket) {
        const tasks = bucket.tasks || [];
        const taskCount = tasks.length;
        
        return `
            <div class="kanban-column" data-bucket-id="${bucket.id}">
                <div class="kanban-column-header">
                    <span class="column-title">${bucket.title}</span>
                    <span class="column-count">${taskCount}</span>
                </div>
                <div class="kanban-cards-list" data-bucket-id="${bucket.id}">
                    ${tasks.map(task => this.renderCard(task)).join('')}
                </div>
            </div>
        `;
    }

    renderCard(task) {
        // Priority styles mapping
        let priorityBadge = '';
        if (task.priority > 0) {
            const prioClass = `priority-${task.priority}`;
            let prioLabel = 'P0';
            if (task.priority === 1) prioLabel = 'Low';
            else if (task.priority === 2) prioLabel = 'Medium';
            else if (task.priority === 3) prioLabel = 'High';
            else if (task.priority === 4) prioLabel = 'Urgent';
            else if (task.priority === 5) prioLabel = 'DOOM';
            
            priorityBadge = `<span class="kanban-badge ${prioClass}">${prioLabel}</span>`;
        }
        
        // Labels layout
        let labelsHtml = '';
        if (task.labels && task.labels.length > 0) {
            labelsHtml = `
                <div class="kanban-card-labels">
                    ${task.labels.map(lbl => {
                        const style = lbl.hex_color ? `style="background-color: #${lbl.hex_color}25; color: #${lbl.hex_color}; border: 1px solid #${lbl.hex_color}40;"` : '';
                        return `<span class="kanban-label-pill" ${style}>${lbl.title}</span>`;
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
            <div class="kanban-card" data-task-id="${task.id}">
                <div class="kanban-card-title">${this.escapeHtml(task.title)}</div>
                ${labelsHtml}
                <div class="kanban-card-meta">
                    <div class="meta-left">
                        <span class="kanban-task-id">${idLabel}</span>
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
        if (!str) return '';
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
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
                onEnd: async (evt) => {
                    const taskId = evt.item.dataset.taskId;
                    const oldBucketId = evt.from.dataset.bucketId;
                    const newBucketId = evt.to.dataset.bucketId;
                    
                    if (oldBucketId === newBucketId) return;
                    
                    this.updateColumnCounts(container);
                    
                    try {
                        await this.moveTask(taskId, newBucketId);
                        this.app.showToast('Task updated successfully.', { type: 'success' });
                    } catch (err) {
                        console.error('Failed to move task:', err);
                        this.app.showToast(`Failed to move task: ${err.message}`, { type: 'error' });
                        
                        // Revert drag
                        evt.from.appendChild(evt.item);
                        this.updateColumnCounts(container);
                    }
                }
            });
        });
    }

    updateColumnCounts(container) {
        container.querySelectorAll('.kanban-column').forEach(col => {
            const count = col.querySelectorAll('.kanban-card').length;
            col.querySelector('.column-count').textContent = count;
        });
    }

    async moveTask(taskId, newBucketId) {
        await this.apiPost(`/tasks/${taskId}`, {
            bucket_id: parseInt(newBucketId)
        });
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

    async apiPost(path, body) {
        const token = sessionStorage.getItem('vikunja_token');
        const url = localStorage.getItem('vikunja_url');
        const proxyUrl = `/api/proxy?url=${encodeURIComponent(url + '/api/v1' + path)}`;
        
        const res = await fetch(proxyUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
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
}
