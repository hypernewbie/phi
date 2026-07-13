/* Φ phi — Markdown Docs Viewer */

import { relativeToCwd, escapeHtml } from './util.js';

export class MarkdownManager {
    constructor(app) {
        this.app = app;
        this.fileListEl = document.getElementById('markdown-file-list');
        this.modal = document.getElementById('md-modal');
        this.modalTitle = document.getElementById('md-modal-title');
        this.modalBody = document.getElementById('md-modal-body');
        this.modalClose = document.getElementById('md-modal-close');
        this.modalCopyBtn = document.getElementById('md-modal-copy-btn');
        this.currentRawContent = '';
        this.markdownClipboard = null;
        this.contextMenuEl = this._createContextMenu();
        this.lastRefreshCwd = null;
        this.refreshRequestId = 0;

        this._configureMarked();
        this._setupEventListeners();
    }

    _configureMarked() {
        if (!window.marked) return;
        window.marked.setOptions({
            gfm: true,
            breaks: false,
        });
    }

    _setupEventListeners() {
        this.modalClose.addEventListener('click', () => this.closeModal());
        this.modal.addEventListener('click', (e) => {
            if (e.target === this.modal) this.closeModal();
        });
        const helpBtn = document.getElementById('phi-help-btn');
        if (helpBtn) {
            helpBtn.addEventListener('click', () => this.openHelpModal());
        }

        if (this.modalCopyBtn) {
            this.modalCopyBtn.addEventListener('click', () => {
                if (this.currentRawContent) {
                    this._copyToClipboard(this.currentRawContent, 'Copied markdown content to clipboard');
                } else {
                    this.app.showToast('No content to copy', { type: 'error' });
                }
            });
        }

        // Sidebar version text doubles as a changelog trigger.
        const changelogBtn = document.getElementById('phi-changelog-btn');
        if (changelogBtn) {
            changelogBtn.addEventListener('click', () => this.openChangelogModal());
        }

        // Manual restart button (sidebar footer ↻). Always available for
        // every install method - just calls /api/restart. The user is
        // expected to have updated phi themselves beforehand (git pull &&
        // go install ., npm i -g phi-code, replacing the standalone
        // binary, etc.). We deliberately do NOT auto-detect a new binary
        // on disk: the user knows what they did better than we do.
        this.restartModal = document.getElementById('restart-modal');
        this.restartModalClose = document.getElementById('restart-modal-close');
        this.restartModalCancel = document.getElementById('restart-modal-cancel');
        this.restartModalConfirm = document.getElementById('restart-modal-confirm');
        const restartBtn = document.getElementById('phi-restart-btn');
        if (restartBtn) {
            restartBtn.addEventListener('click', () => this._openRestartModal());
        }
        if (this.restartModalClose) {
            this.restartModalClose.addEventListener('click', () => this._closeRestartModal());
        }
        if (this.restartModalCancel) {
            this.restartModalCancel.addEventListener('click', () => this._closeRestartModal());
        }
        if (this.restartModal) {
            this.restartModal.addEventListener('click', (e) => {
                if (e.target === this.restartModal) this._closeRestartModal();
            });
        }
        if (this.restartModalConfirm) {
            this.restartModalConfirm.addEventListener('click', () => this._doRestart());
        }
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (!this.modal.classList.contains('hidden')) {
                    this.closeModal();
                }
                this._hideContextMenu();
            }
        });
        document.addEventListener('click', (e) => {
            if (this.contextMenuEl && !e.target.closest('.md-context-menu') && !e.target.closest('.md-file-action-btn')) {
                this._hideContextMenu();
            }
        });
    }

    async refreshFiles(options = {}) {
        const force = options.force !== false;
        
        const diffCtrl = this.app.diffController;
        if (!force && diffCtrl && (!diffCtrl.isPanelOpen || diffCtrl.activeTab !== 'markdown')) {
            return;
        }

        const cwd = this.app.sessionsManager.activeCWD || '';
        if (!force && this.lastRefreshCwd === cwd) {
            return;
        }

        this.lastRefreshCwd = cwd;
        const requestId = ++this.refreshRequestId;
        this.fileListEl.innerHTML = '<div class="md-list-loading">Scanning...</div>';
        try {
            const res = await fetch(`/api/markdown/files?cwd=${encodeURIComponent(cwd)}`);
            if (!res.ok) throw new Error(await res.text());
            const files = await res.json();
            if (requestId !== this.refreshRequestId) return;
            this._renderFileList(files);
        } catch (e) {
            if (requestId !== this.refreshRequestId) return;
            this.fileListEl.innerHTML = `<div class="md-list-error">Failed to load: ${e.message}</div>`;
        }
    }

    _renderFileList(files) {
        this.fileListEl.innerHTML = '';

        const allDirs = this.app.markdownDirs || [];
        const byDir = {};
        allDirs.forEach(d => {
            byDir[d] = [];
        });

        if (files && files.length > 0) {
            files.forEach(f => {
                if (!byDir[f.dir]) byDir[f.dir] = [];
                byDir[f.dir].push(f);
            });
        }

        if (Object.keys(byDir).length === 0) {
            this.fileListEl.innerHTML = '<div class="md-list-empty">No markdown directories configured.</div>';
        } else {
            for (const [dir, dirFiles] of Object.entries(byDir)) {
                const group = document.createElement('div');
                group.className = 'md-file-group';

                const dirLabel = document.createElement('div');
                dirLabel.className = 'md-dir-label';
                
                const nameSpan = document.createElement('span');
                nameSpan.innerText = dir;
                dirLabel.appendChild(nameSpan);

                const delBtn = document.createElement('button');
                delBtn.className = 'md-dir-del-btn';
                delBtn.innerHTML = '×';
                delBtn.title = `Remove directory "${dir}"`;
                delBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    if (confirm(`Remove directory "${dir}" from markdown search list?`)) {
                        try {
                            await fetch('/api/config/markdown-dirs', {
                                method: 'DELETE',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ dir })
                            });
                            await this.app.sessionsManager.loadConfig(); // Refresh cache!
                            this.refreshFiles();
                        } catch (err) {
                            console.error("Failed to delete markdown dir:", err);
                        }
                    }
                });
                dirLabel.appendChild(delBtn);
                group.appendChild(dirLabel);

                if (dirFiles.length === 0) {
                    const emptyHint = document.createElement('div');
                    emptyHint.className = 'md-file-empty-hint';
                    emptyHint.innerText = 'No files found';
                    group.appendChild(emptyHint);
                } else {
                    dirFiles.forEach(f => {
                        const row = document.createElement('div');
                        row.className = 'md-file-row';

                        const item = document.createElement('button');
                        item.className = 'md-file-item';
                        item.innerHTML = `<span class="md-file-icon">📄</span><span class="md-file-name">${f.name}</span>`;
                        item.title = f.path;
                        
                        item.addEventListener('click', (e) => {
                            if (e.ctrlKey || e.metaKey) {
                                e.preventDefault();
                                this._insertRelativePath(f);
                            } else {
                                this.openFile(f);
                            }
                        });

                        item.addEventListener('contextmenu', (e) => {
                            e.preventDefault();
                            this._showContextMenu(f, actionBtn);
                        });

                        const actionBtn = document.createElement('button');
                        actionBtn.className = 'md-file-action-btn';
                        actionBtn.innerHTML = '⋯';
                        actionBtn.title = `Actions for ${f.name}`;
                        actionBtn.addEventListener('click', (e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            this._showContextMenu(f, actionBtn);
                        });

                        row.appendChild(item);
                        row.appendChild(actionBtn);
                        group.appendChild(row);
                    });
                }

                this.fileListEl.appendChild(group);
            }
        }

        // Dir management row at the bottom
        const manageRow = document.createElement('div');
        manageRow.className = 'md-manage-row';
        const addDirBtn = document.createElement('button');
        addDirBtn.className = 'md-manage-btn';
        addDirBtn.innerText = '+ Add Dir';
        addDirBtn.addEventListener('click', () => this._promptAddDir());
        manageRow.appendChild(addDirBtn);
        this.fileListEl.appendChild(manageRow);
    }

    async openFile(f) {
        const cwd = this.app.sessionsManager.activeCWD || '';
        this.modalTitle.innerText = f.name;
        this.modalBody.innerHTML = '<div class="md-rendering">Rendering...</div>';
        this.modal.classList.remove('hidden');
        this.currentRawContent = '';

        try {
            const res = await fetch(`/api/markdown/file?path=${encodeURIComponent(f.path)}&cwd=${encodeURIComponent(cwd)}`);
            if (!res.ok) throw new Error(await res.text());
            const raw = await res.text();
            this.currentRawContent = raw;
            const html = window.marked ? window.marked.parse(raw) : `<pre>${this._escape(raw)}</pre>`;
            this.modalBody.innerHTML = `<div class="md-rendered">${html}</div>`;

            // Syntax highlight any code blocks
            if (window.hljs) {
                this.modalBody.querySelectorAll('pre code').forEach(el => {
                    window.hljs.highlightElement(el);
                });
            }
        } catch (e) {
            this.modalBody.innerHTML = `<div class="md-list-error">Failed to load: ${e.message}</div>`;
        }
    }

    closeModal() {
        this.modal.classList.add('hidden');
        this.modalBody.innerHTML = '';
        this.currentRawContent = '';
    }

    _openRestartModal() {
        if (this.restartModal) this.restartModal.classList.remove('hidden');
    }

    _closeRestartModal() {
        if (this.restartModal) this.restartModal.classList.add('hidden');
    }

    async _doRestart() {
        if (this.restartModalConfirm) {
            this.restartModalConfirm.disabled = true;
            this.restartModalConfirm.textContent = 'Restarting…';
        }
        if (this.restartModalCancel) this.restartModalCancel.disabled = true;
        try {
            const res = await fetch('/api/restart', { method: 'POST' });
            if (!res.ok) {
                const errText = await res.text().catch(() => 'unknown error');
                throw new Error(errText || `HTTP ${res.status}`);
            }
            // The 0x05 frame from /api/restart will fire handleServerShutdown
            // which shows its own toast and reloads the page. Nothing to do here.
        } catch (err) {
            this.app.showToast(`Restart failed: ${err.message}`, { type: 'error' });
            if (this.restartModalConfirm) {
                this.restartModalConfirm.disabled = false;
                this.restartModalConfirm.textContent = 'Restart';
            }
            if (this.restartModalCancel) this.restartModalCancel.disabled = false;
        }
    }

    openRawMarkdown(title, rawMarkdown) {
        this.modalTitle.innerText = title;
        this.currentRawContent = rawMarkdown;
        const html = window.marked ? window.marked.parse(rawMarkdown) : `<pre>${this._escape(rawMarkdown)}</pre>`;
        this.modalBody.innerHTML = `<div class="md-rendered">${html}</div>`;
        if (window.hljs) {
            this.modalBody.querySelectorAll('pre code').forEach(el => {
                window.hljs.highlightElement(el);
            });
        }
        this.modal.classList.remove('hidden');
    }

    async openHelpModal() {
        this.modalTitle.innerText = 'Phi Documentation';
        this.modalBody.innerHTML = '<div class="md-rendering">Loading help...</div>';
        this.currentRawContent = '';
        this.modal.classList.remove('hidden');

        try {
            const res = await fetch('help.md', { cache: 'no-store' });
            if (!res.ok) throw new Error(await res.text() || 'Failed to load help.md');
            const raw = await res.text();
            this.openRawMarkdown('Phi Documentation', raw);
        } catch (e) {
            this.modalBody.innerHTML = `<div class="md-list-error">Failed to load help: ${e.message}</div>`;
            this.app.showToast(`Failed to open help: ${e.message}`, { type: 'error', title: 'Help' });
        }
    }

    // openDiagModal — Phase 10: server diagnostics panel. Hits /api/diag
    // and renders a structured table (version, goroutines, mem, PTYs).
    // Useful for F4 debugging (hub overflow, slow client) and for ops
    // to verify the server is healthy from the browser. Auto-refreshes
    // every 2s while open.
    async openDiagModal() {
        this.modalTitle.innerText = 'Phi Diagnostics';
        this.modalBody.innerHTML = '<div class="md-rendering">Loading diagnostics…</div>';
        this.currentRawContent = '';
        this.modal.classList.remove('hidden');

        const render = (d) => {
            if (!d) {
                this.modalBody.innerHTML = `<div class="md-list-error">No data.</div>`;
                return;
            }
            const rows = [
                ['Version', d.version || 'dev'],
                ['Install', d.install_method || '—'],
                ['Uptime (s)', (d.uptime_seconds || 0).toFixed(0)],
                ['Goroutines', d.goroutines],
                ['Mem alloc (MB)', d.mem_alloc_mb.toFixed(1)],
                ['PTYs', d.pty_count],
            ];
            const body = rows.map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(String(v))}</td></tr>`).join('');
            const panes = (d.panes || []).map(p => {
                const pct = p.ring_capacity > 0 ? Math.round(p.ring_bytes * 100 / p.ring_capacity) : 0;
                return `<tr>
                    <td>${escapeHtml(p.title || p.id.slice(0, 8))}</td>
                    <td>${escapeHtml(p.coder || '—')}</td>
                    <td>${p.client_count}</td>
                    <td>${p.ring_bytes}/${p.ring_capacity} (${pct}%)</td>
                    <td>${p.busy ? 'busy' : 'idle'}</td>
                </tr>`;
            }).join('');
            this.modalBody.innerHTML = `
                <div class="diag-panel">
                    <table class="diag-table"><tbody>${body}</tbody></table>
                    <h4>Panes (${(d.panes || []).length})</h4>
                    <table class="diag-table diag-table-panes">
                        <thead><tr><th>Title</th><th>Coder</th><th>Clients</th><th>Ring</th><th>State</th></tr></thead>
                        <tbody>${panes || '<tr><td colspan=5>(no panes)</td></tr>'}</tbody>
                    </table>
                    <p class="diag-foot">Auto-refreshing every 2s. Close to stop.</p>
                </div>
            `;
        };

        const refresh = async () => {
            try {
                const res = await fetch('/api/diag');
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                render(data);
            } catch (err) {
                this.modalBody.innerHTML = `<div class="md-list-error">Failed: ${escapeHtml(err.message)}</div>`;
            }
        };
        await refresh();
        if (this._diagInterval) clearInterval(this._diagInterval);
        this._diagInterval = setInterval(() => {
            if (this.modal.classList.contains('hidden')) {
                clearInterval(this._diagInterval);
                this._diagInterval = null;
                return;
            }
            refresh();
        }, 2000);
    }

    // Sidebar version text opens this. Uses the same md-modal widget as
    // help.md so the rendering, copy button, and close/escape behavior are
    // consistent. The version is appended to the title so users see exactly
    // which release they're reading the changelog for.
    async openChangelogModal() {
        const versionEl = document.getElementById('phi-changelog-btn');
        const version = (versionEl && versionEl.textContent || '').trim();
        const title = version ? `Changelog — ${version}` : 'Changelog';
        this.modalTitle.innerText = title;
        this.modalBody.innerHTML = '<div class="md-rendering">Loading changelog...</div>';
        this.currentRawContent = '';
        this.modal.classList.remove('hidden');

        // Build the update banner up front so it can render alongside
        // the changelog body. We do this synchronously (cheap DOM ops) and
        // then stream the changelog content in.
        const updateBanner = this._buildUpdateBanner();
        if (updateBanner) {
            this.modalBody.innerHTML = '';
            this.modalBody.appendChild(updateBanner);
            const changelogHolder = document.createElement('div');
            changelogHolder.className = 'md-rendering';
            changelogHolder.textContent = 'Loading changelog...';
            this.modalBody.appendChild(changelogHolder);
        }

        try {
            const res = await fetch('changelog.md', { cache: 'no-store' });
            if (!res.ok) throw new Error(await res.text() || 'Failed to load changelog.md');
            const raw = await res.text();
            this.openRawMarkdown(title, raw);
        } catch (e) {
            this.modalBody.innerHTML = `<div class="md-list-error">Failed to load changelog: ${e.message}</div>`;
            this.app.showToast(`Failed to open changelog: ${e.message}`, { type: 'error', title: 'Changelog' });
        }
    }

    // _buildUpdateBanner — Phase 7/8 UI affordance. Returns a banner
    // element when /api/update/status reported an update AND the install
    // method is eligible for self-update. Otherwise null. For ineligible
    // methods (go-install/dev) we still show instructions, just without
    // the Apply button.
    _buildUpdateBanner() {
        const status = this.app && this.app.updateStatus;
        if (!status || !status.update_available || status.current === 'dev') return null;

        const banner = document.createElement('div');
        banner.className = 'update-banner';

        const head = document.createElement('div');
        head.className = 'update-banner-head';
        head.innerHTML = `<span class="update-banner-icon">↑</span>
            <span class="update-banner-title">Update available: ${escapeHtml(status.latest)}</span>`;
        banner.appendChild(head);

        const body = document.createElement('div');
        body.className = 'update-banner-body';
        body.textContent = status.instructions || '';
        banner.appendChild(body);

        // Show Apply button only for eligible install methods (npm / standalone).
        // Server-side enforce too: POST /api/update/apply returns 403 otherwise.
        if (status.install_method === 'npm' || status.install_method === 'standalone') {
            const actions = document.createElement('div');
            actions.className = 'update-banner-actions';
            const applyBtn = document.createElement('button');
            applyBtn.className = 'update-banner-btn';
            applyBtn.textContent = `Apply & restart next time`;
            applyBtn.title = 'Stage the binary. phi restarts into it next time it restarts (manual: Ctrl+C + relaunch).';
            applyBtn.addEventListener('click', () => this._startUpdateApply(status.latest, applyBtn, banner));
            actions.appendChild(applyBtn);

            // Phase 9 T3: 'Apply & restart now' chains the staged swap
            // with an immediate server restart. Disabled for npm because
            // the npm shim owns the child lifecycle; restarting the
            // server mid-update leaves the shim in a weird state. Plan
            // §3.5 'npm-shim consideration'.
            if (status.install_method === 'standalone') {
                const restartBtn = document.createElement('button');
                restartBtn.className = 'update-banner-btn update-banner-btn-restart';
                restartBtn.textContent = 'Apply & restart now';
                restartBtn.title = 'Stage the binary and immediately restart phi. Browser will reload.';
                restartBtn.addEventListener('click', () => this._startUpdateApplyAndRestart(status.latest, restartBtn, applyBtn, banner));
                actions.appendChild(restartBtn);
            }

            banner.appendChild(actions);
        }

        return banner;
    }

    async _startUpdateApply(version, btn, banner) {
        btn.disabled = true;
        btn.textContent = 'Starting…';
        const progressEl = document.createElement('div');
        progressEl.className = 'update-banner-progress';
        progressEl.textContent = 'starting…';
        banner.appendChild(progressEl);

        try {
            const res = await fetch('/api/update/apply', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ version })
            });
            if (!res.ok) {
                const errText = await res.text();
                throw new Error(errText || `HTTP ${res.status}`);
            }
        } catch (err) {
            btn.disabled = false;
            btn.textContent = `Apply & restart next time`;
            progressEl.textContent = `Error: ${err.message}`;
            progressEl.classList.add('error');
            return;
        }

        // Poll progress until terminal phase (done/error).
        const pollIntervalMs = 500;
        const poll = async () => {
            try {
                const r = await fetch('/api/update/progress');
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                const p = await r.json();
                progressEl.textContent = this._formatProgress(p);
                progressEl.classList.toggle('error', p.phase === 'error');
                if (p.phase === 'done' || p.phase === 'error') {
                    if (p.phase === 'done') {
                        btn.textContent = `Staged ${version} — restart into it`;
                        this.app.showToast(`Update staged. Restart phi to apply ${version}.`, { type: 'success' });
                    } else {
                        btn.disabled = false;
                        btn.textContent = `Retry apply`;
                    }
                    return;
                }
            } catch (err) {
                progressEl.textContent = `polling: ${err.message}`;
            }
            setTimeout(poll, pollIntervalMs);
        };
        setTimeout(poll, pollIntervalMs);
    }

    _formatProgress(p) {
        if (!p || !p.phase) return '';
        switch (p.phase) {
            case 'downloading': return `Downloading… ${p.pct}%`;
            case 'verifying':   return 'Verifying checksum…';
            case 'extracting':  return 'Extracting binary…';
            case 'staging':     return 'Staging swap…';
            case 'done':        return `Staged. Old binary kept at ${p.old_path || 'phi.old'}.`;
            case 'error':       return `Error: ${p.error || 'unknown'}`;
            default:            return p.phase;
        }
    }

    // _startUpdateApplyAndRestart chains Phase 8 apply + Phase 9 restart.
    // Only available for standalone installs (npm shim owns the child,
    // see plan §3.5). The WS 0x05 handler in terminal.js arms the page
    // reload; the staging step must complete BEFORE the restart, so
    // we poll progress until phase==done before POSTing /api/restart.
    async _startUpdateApplyAndRestart(version, restartBtn, applyBtn, banner) {
        restartBtn.disabled = true;
        applyBtn.disabled = true;
        restartBtn.textContent = 'Staging…';
        const progressEl = banner.querySelector('.update-banner-progress');
        if (progressEl) progressEl.textContent = 'staging…';

        // Trigger the apply and poll.
        try {
            const res = await fetch('/api/update/apply', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ version })
            });
            if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
        } catch (err) {
            restartBtn.disabled = false;
            applyBtn.disabled = false;
            restartBtn.textContent = 'Apply & restart now';
            if (progressEl) {
                progressEl.textContent = `Error: ${err.message}`;
                progressEl.classList.add('error');
            }
            return;
        }

        const waitForStaged = async () => {
            const r = await fetch('/api/update/progress');
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const p = await r.json();
            if (progressEl) {
                progressEl.textContent = this._formatProgress(p);
                progressEl.classList.toggle('error', p.phase === 'error');
            }
            if (p.phase === 'done') return true;
            if (p.phase === 'error') throw new Error(p.error || 'staging failed');
            return false;
        };

        try {
            for (;;) {
                if (await waitForStaged()) break;
                await new Promise(r => setTimeout(r, 500));
            }
        } catch (err) {
            restartBtn.disabled = false;
            applyBtn.disabled = false;
            restartBtn.textContent = 'Apply & restart now';
            return;
        }

        // Staged. Now restart. The 0x05 frame will arm the reload poller;
        // we ALSO trigger the reload as a backup (in case the WS isn't
        // connected). Best-effort; ignore errors since the page is dying.
        restartBtn.textContent = 'Restarting…';
        if (progressEl) progressEl.textContent = 'staged, restarting…';
        try {
            await fetch('/api/restart', { method: 'POST' });
        } catch (_) {
            // Server is dying; expected.
        }
        // Hard reload fallback in case the WS-driven reload doesn't fire
        // within a couple of seconds (network blip, browser backgrounded).
        setTimeout(() => window.location.reload(), 2500);
    }

    async _promptAddDir() {
        const dir = prompt("Add markdown directory (relative to workspace, e.g. ./docs):");
        if (!dir || !dir.trim()) return;
        try {
            await fetch('/api/config/markdown-dirs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ dir: dir.trim() })
            });
            await this.app.sessionsManager.loadConfig(); // Refresh cache!
            this.refreshFiles();
        } catch (e) {
            console.error("Failed to add markdown dir:", e);
        }
    }

    _createContextMenu() {
        const menu = document.createElement('div');
        menu.className = 'md-context-menu hidden';
        document.body.appendChild(menu);
        return menu;
    }

    _showContextMenu(file, anchorEl) {
        if (!this.contextMenuEl) return;
        this.contextMenuEl.innerHTML = '';

        const actions = [
            { icon: '⧉', label: 'Copy', className: 'copy', handler: () => this._copyMarkdownFile(file) },
            { icon: '⇉', label: 'Copy to all worktrees', className: 'copy-all', handler: () => this._copyMarkdownFileToAllWorktrees(file) },
            { icon: '⇩', label: 'Paste…', className: 'paste', handler: () => this._pasteMarkdownFile(file) },
            { icon: '🗑', label: 'Delete…', className: 'delete', handler: () => this._deleteMarkdownFile(file) },
        ];

        actions.forEach(action => {
            const btn = document.createElement('button');
            btn.className = `md-context-action ${action.className}`;
            btn.innerHTML = `<span class="md-context-icon">${action.icon}</span><span class="md-context-label">${action.label}</span>`;
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                this._hideContextMenu();
                await action.handler();
            });
            this.contextMenuEl.appendChild(btn);
        });

        const rect = anchorEl.getBoundingClientRect();
        this.contextMenuEl.classList.remove('hidden');
        const menuRect = this.contextMenuEl.getBoundingClientRect();
        const left = Math.max(8, Math.min(rect.right - menuRect.width, window.innerWidth - menuRect.width - 8));
        const top = Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - menuRect.height - 8));
        this.contextMenuEl.style.left = `${left}px`;
        this.contextMenuEl.style.top = `${top}px`;
    }

    _hideContextMenu() {
        if (!this.contextMenuEl) return;
        this.contextMenuEl.classList.add('hidden');
    }

    async _copyMarkdownFile(file) {
        try {
            const cwd = this.app.sessionsManager.activeCWD || '';
            const res = await fetch(`/api/markdown/file?path=${encodeURIComponent(file.path)}&cwd=${encodeURIComponent(cwd)}`);
            if (!res.ok) throw new Error(await res.text());
            const content = await res.text();
            this.markdownClipboard = { name: file.name, dir: file.dir, content };
            this.app.showToast(`Copied "${file.name}"`, { type: 'info', title: 'Markdown Clipboard' });
        } catch (e) {
            this.app.showToast(`Failed to copy file: ${e.message}`, { type: 'error', title: 'Markdown Clipboard' });
        }
    }

    async _copyMarkdownFileToAllWorktrees(file) {
        try {
            const cwd = this.app.sessionsManager.activeCWD || '';
            const res = await fetch('/api/markdown/copy-all-worktrees', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cwd, dir: file.dir, path: file.path })
            });
            if (!res.ok) throw new Error(await res.text());
            const result = await res.json();
            this.app.showToast(`Copied "${file.name}" to ${result.copied} worktree(s)`, { type: 'info', title: 'Markdown' });
        } catch (e) {
            this.app.showToast(`Failed to copy to worktrees: ${e.message}`, { type: 'error', title: 'Markdown' });
        }
    }

    async _pasteMarkdownFile(file) {
        if (!this.markdownClipboard) {
            this.app.showToast('Nothing copied yet', { type: 'error', title: 'Markdown Clipboard' });
            return;
        }
        const suggested = this.markdownClipboard.name;
        let name = prompt('Paste as filename:', suggested);
        if (!name || !name.trim()) return;
        name = name.trim();

        const doPaste = async (overwrite = false) => {
            const cwd = this.app.sessionsManager.activeCWD || '';
            const res = await fetch('/api/markdown/paste', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cwd, dir: file.dir, name, content: this.markdownClipboard.content, overwrite })
            });
            if (res.status === 409 && !overwrite) {
                if (confirm(`"${name}" already exists. Overwrite it?`)) {
                    return doPaste(true);
                }
                return;
            }
            if (!res.ok) throw new Error(await res.text());
            this.app.showToast(`Pasted as "${name}"`, { type: 'info', title: 'Markdown Clipboard' });
            await this.refreshFiles();
        };

        try {
            await doPaste(false);
        } catch (e) {
            this.app.showToast(`Failed to paste file: ${e.message}`, { type: 'error', title: 'Markdown Clipboard' });
        }
    }

    async _deleteMarkdownFile(file) {
        if (!confirm(`Delete markdown file "${file.name}"?`)) return;
        try {
            const cwd = this.app.sessionsManager.activeCWD || '';
            const res = await fetch('/api/markdown/delete', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cwd, path: file.path })
            });
            if (!res.ok) throw new Error(await res.text());
            this.app.showToast(`Deleted "${file.name}"`, { type: 'info', title: 'Markdown' });
            await this.refreshFiles();
        } catch (e) {
            this.app.showToast(`Failed to delete file: ${e.message}`, { type: 'error', title: 'Markdown' });
        }
    }

    _escape(text) {
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    _insertRelativePath(f) {
        const cwd = this.app.sessionsManager.activeCWD || '';
        const relPath = relativeToCwd(f.path, cwd);
        
        const textarea = document.getElementById('input-textarea');
        if (textarea) {
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            const text = textarea.value;
            const before = text.substring(0, start);
            const after = text.substring(end, text.length);
            
            const padBefore = (start > 0 && !before.endsWith(' ')) ? ' ' : '';
            const padAfter = (!after.startsWith(' ') && after.length > 0) ? ' ' : '';
            
            textarea.value = before + padBefore + relPath + padAfter + after;
            
            const newPos = start + padBefore.length + relPath.length;
            textarea.setSelectionRange(newPos, newPos);
            textarea.focus({ preventScroll: true });
            
            if (this.app.tabManager) {
                this.app.tabManager.adjustInputHeight();
            }
        }
    }

    async _copyToClipboard(text, msg) {
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text);
            } else {
                const ta = Object.assign(document.createElement('textarea'), { value: text });
                ta.style.cssText = 'position:fixed;opacity:0';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                ta.remove();
            }
            this.app.showToast(msg, { type: 'info', title: 'Clipboard' });
        } catch (err) {
            this.app.showToast('Failed to copy content', { type: 'error' });
        }
    }
}
