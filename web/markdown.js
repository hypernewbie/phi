/* Φ phi — Markdown Docs Viewer */

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
        if (this.modalCopyBtn) {
            this.modalCopyBtn.addEventListener('click', () => {
                if (this.currentRawContent) {
                    this._copyToClipboard(this.currentRawContent, 'Copied markdown content to clipboard');
                } else {
                    this.app.showToast('No content to copy', { type: 'error' });
                }
            });
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

    async refreshFiles() {
        this.fileListEl.innerHTML = '<div class="md-list-loading">Scanning...</div>';
        const cwd = this.app.sessionsManager.activeCWD || '';
        try {
            const res = await fetch(`/api/markdown/files?cwd=${encodeURIComponent(cwd)}`);
            if (!res.ok) throw new Error(await res.text());
            const files = await res.json();
            this._renderFileList(files);
        } catch (e) {
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
            { label: 'Copy', className: 'copy', handler: () => this._copyMarkdownFile(file) },
            { label: 'Copy to all worktrees', className: 'copy-all', handler: () => this._copyMarkdownFileToAllWorktrees(file) },
            { label: 'Paste…', className: 'paste', handler: () => this._pasteMarkdownFile(file) },
            { label: 'Delete…', className: 'delete', handler: () => this._deleteMarkdownFile(file) },
        ];

        actions.forEach(action => {
            const btn = document.createElement('button');
            btn.className = `md-context-action ${action.className}`;
            btn.textContent = action.label;
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
        const cleanPath = f.path.replace(/\\/g, '/');
        const cleanCwd = cwd.replace(/\\/g, '/');
        
        let relPath = cleanPath;
        if (cleanCwd && cleanPath.startsWith(cleanCwd)) {
            relPath = cleanPath.slice(cleanCwd.length);
            if (relPath.startsWith('/')) {
                relPath = relPath.slice(1);
            }
        }
        
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
            textarea.focus();
            
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
