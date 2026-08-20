/* Φ phi — File tree (files tab in right panel) */
import { formatAttachment } from './attachments.js';
import { escapeHtml } from './util.js';
const FILE_ICON_SVG = `<svg class="md-file-icon md-file-icon-doc" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="8" y1="13" x2="16" y2="13"></line><line x1="8" y1="17" x2="13" y2="17"></line></svg>`;
export class FileTreeManager {
    app;
    treeEl;
    contextMenuEl;
    expanded;
    refreshRequestId;
    constructor(app) {
        this.app = app;
        this.treeEl = document.getElementById('file-tree-list');
        this.expanded = new Set();
        this.refreshRequestId = 0;
        this.contextMenuEl = this._createContextMenu();
        this._setupEventListeners();
    }
    _setupEventListeners() {
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape')
                this._hideContextMenu();
        });
        document.addEventListener('click', (e) => {
            if (this.contextMenuEl &&
                !e.target.closest('.ft-context-menu') &&
                !e.target.closest('.md-file-action-btn')) {
                this._hideContextMenu();
            }
        });
    }
    // refresh re-renders the whole tree for the active cwd, refetching the
    // root and every expanded directory (no cache — freshness by refetch).
    // Callers are already gated on the files tab being visible (refreshDiff's
    // files branch and _toggleDir), so no visibility check is needed here.
    async refresh() {
        const requestId = ++this.refreshRequestId;
        this.treeEl.innerHTML = '<div class="md-list-loading">Loading...</div>';
        try {
            const frag = await this._renderDir('', 0, requestId);
            if (requestId !== this.refreshRequestId || !frag)
                return;
            this.treeEl.innerHTML = '';
            this.treeEl.appendChild(frag);
        }
        catch (e) {
            if (requestId !== this.refreshRequestId)
                return;
            this.treeEl.innerHTML = `<div class="md-list-error">Failed to load: ${escapeHtml(e.message)}</div>`;
        }
    }
    async _fetchDir(rel) {
        const cwd = this.app.sessionsManager.activeCWD || '';
        const res = await fetch(`/api/fs/list?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(rel)}`);
        if (!res.ok)
            throw new Error(await res.text());
        return await res.json();
    }
    // Renders one directory level; recurses into expanded children. An
    // expanded child that fails to list (deleted, now-ignored, or a stale
    // relpath after a cwd switch) is silently pruned from the expanded set
    // rather than failing the whole tree — deliberate: do NOT add
    // expanded-set clearing on cwd change.
    async _renderDir(rel, depth, requestId) {
        const data = await this._fetchDir(rel);
        if (requestId !== this.refreshRequestId)
            return null;
        const frag = document.createDocumentFragment();
        if (rel === '' && data.entries.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'md-list-empty';
            empty.textContent = 'No files';
            frag.appendChild(empty);
            return frag;
        }
        for (const entry of data.entries) {
            const childRel = rel ? `${rel}/${entry.name}` : entry.name;
            frag.appendChild(this._buildRow(entry, childRel, depth));
            if (entry.dir && this.expanded.has(childRel)) {
                try {
                    const sub = await this._renderDir(childRel, depth + 1, requestId);
                    if (requestId !== this.refreshRequestId)
                        return null;
                    if (sub)
                        frag.appendChild(sub);
                }
                catch {
                    this.expanded.delete(childRel);
                }
            }
        }
        if (data.truncated) {
            const note = document.createElement('div');
            note.className = 'md-list-empty';
            note.textContent = '… list truncated';
            frag.appendChild(note);
        }
        return frag;
    }
    _buildRow(entry, rel, depth) {
        const row = document.createElement('div');
        row.className = 'md-file-row';
        const item = document.createElement('button');
        item.className = 'md-file-item';
        item.style.paddingLeft = `${8 + depth * 14}px`;
        item.title = rel;
        if (entry.dir) {
            const chev = this.expanded.has(rel) ? '▾' : '▸';
            item.innerHTML = `<span class="ft-chevron">${chev}</span><span class="md-file-name">${escapeHtml(entry.name)}</span>`;
            item.addEventListener('click', () => this._toggleDir(rel));
        }
        else {
            item.innerHTML = `${FILE_ICON_SVG}<span class="md-file-name">${escapeHtml(entry.name)}</span>`;
            item.addEventListener('click', () => this._insertPath(rel));
        }
        const actionBtn = document.createElement('button');
        actionBtn.className = 'md-file-action-btn';
        actionBtn.innerHTML = '⋯';
        actionBtn.title = `Actions for ${entry.name}`;
        actionBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            this._showContextMenu(rel, actionBtn);
        });
        item.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this._showContextMenu(rel, actionBtn);
        });
        row.appendChild(item);
        row.appendChild(actionBtn);
        return row;
    }
    _toggleDir(rel) {
        if (this.expanded.has(rel)) {
            this.expanded.delete(rel);
        }
        else {
            this.expanded.add(rel);
        }
        this.refresh();
    }
    // Inserts the cwd-relative path into the chat textarea at the cursor,
    // formatted for the active tab's coder (claude → @path, bash → raw).
    // Splice semantics mirror MarkdownManager._insertRelativePath.
    _insertPath(rel) {
        const coder = this.app.tabManager?.getActiveTab?.()?.coder || '';
        const insertText = formatAttachment(coder, { path: rel });
        const textarea = document.getElementById('input-textarea');
        if (!textarea)
            return;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const text = textarea.value;
        const before = text.substring(0, start);
        const after = text.substring(end, text.length);
        const padBefore = start > 0 && !before.endsWith(' ') ? ' ' : '';
        const padAfter = !after.startsWith(' ') && after.length > 0 ? ' ' : '';
        textarea.value = before + padBefore + insertText + padAfter + after;
        const newPos = start + padBefore.length + insertText.length;
        textarea.setSelectionRange(newPos, newPos);
        textarea.focus({ preventScroll: true });
        if (this.app.tabManager) {
            this.app.tabManager.adjustInputHeight();
        }
    }
    _createContextMenu() {
        const menu = document.createElement('div');
        menu.className = 'md-context-menu ft-context-menu hidden';
        document.body.appendChild(menu);
        return menu;
    }
    _showContextMenu(rel, anchorEl) {
        if (!this.contextMenuEl)
            return;
        this.contextMenuEl.innerHTML = '';
        const actions = [
            {
                icon: '@',
                label: 'Insert @path',
                className: 'insert-path',
                handler: () => this._insertPath(rel),
            },
        ];
        actions.forEach((action) => {
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
        if (!this.contextMenuEl)
            return;
        this.contextMenuEl.classList.add('hidden');
    }
}
