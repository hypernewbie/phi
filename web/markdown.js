/* Φ phi — Markdown Docs Viewer */
import { relativeToCwd, escapeHtml } from './util.js';
import { renderMarkdownSafe, rewriteRelativeImages, highlightCodeIn, } from './md-render.js';
import { normalizePath } from './sessions.js';
import { formatAttachment } from './attachments.js';
import { tryNative } from './desktop.js';
export class MarkdownManager {
    app;
    fileListEl;
    modal;
    modalTitle;
    modalBody;
    modalClose;
    modalCopyBtn;
    restartModal;
    restartModalClose;
    restartModalCancel;
    restartModalConfirm;
    pasteModal;
    pasteModalForm;
    pasteModalTitle;
    pasteModalHint;
    pasteModalContent;
    pasteModalName;
    pasteModalDir;
    pasteModalDirLabel;
    pasteModalError;
    pasteModalCancel;
    pasteModalSave;
    pasteModalClose;
    _pastePending;
    _pasteConflict;
    _diagInterval;
    currentRawContent;
    markdownClipboard;
    contextMenuEl;
    refreshRequestId;
    _lastRenderedKey;
    _externalDebounce;
    constructor(app) {
        this.app = app;
        this.fileListEl = document.getElementById('markdown-file-list');
        this.modal = document.getElementById('md-modal');
        this.modalTitle = document.getElementById('md-modal-title');
        this.modalBody = document.getElementById('md-modal-body');
        this.modalClose = document.getElementById('md-modal-close');
        this.modalCopyBtn = document.getElementById('md-modal-copy-btn');
        this.pasteModal = document.getElementById('md-paste-modal');
        this.pasteModalForm = document.getElementById('md-paste-modal-form');
        this.pasteModalTitle = document.getElementById('md-paste-modal-title');
        this.pasteModalHint = document.getElementById('md-paste-modal-hint');
        this.pasteModalContent = document.getElementById('md-paste-modal-content');
        this.pasteModalName = document.getElementById('md-paste-modal-name');
        this.pasteModalDir = document.getElementById('md-paste-modal-dir');
        this.pasteModalDirLabel = document.getElementById('md-paste-modal-dir-label');
        this.pasteModalError = document.getElementById('md-paste-modal-error');
        this.pasteModalCancel = document.getElementById('md-paste-modal-cancel');
        this.pasteModalSave = document.getElementById('md-paste-modal-save');
        this.pasteModalClose = document.getElementById('md-paste-modal-close');
        this._pastePending = false;
        this._pasteConflict = false;
        this.currentRawContent = '';
        this.markdownClipboard = null;
        this.contextMenuEl = this._createContextMenu();
        this.refreshRequestId = 0;
        this._lastRenderedKey = '';
        this._externalDebounce = null;
        this._diagInterval = null;
        this._setupEventListeners();
    }
    _setupEventListeners() {
        this.modalClose.addEventListener('click', () => this.closeModal());
        this.modal.addEventListener('click', (e) => {
            if (e.target === this.modal)
                this.closeModal();
        });
        const helpBtn = document.getElementById('phi-help-btn');
        if (helpBtn) {
            helpBtn.addEventListener('click', () => {
                if (tryNative('help', {}))
                    return;
                void this.openHelpModal();
            });
        }
        if (this.modalCopyBtn) {
            this.modalCopyBtn.addEventListener('click', () => {
                if (this.currentRawContent) {
                    this._copyToClipboard(this.currentRawContent, 'Copied markdown content to clipboard');
                }
                else {
                    this.app.showToast('No content to copy', { type: 'error' });
                }
            });
        }
        // Sidebar version text doubles as a changelog trigger.
        const changelogBtn = document.getElementById('phi-changelog-btn');
        if (changelogBtn) {
            changelogBtn.addEventListener('click', () => {
                if (tryNative('changelog', {}))
                    return;
                void this.openChangelogModal();
            });
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
        // The desktop shell hosts this page with ?desktop=1 and owns the
        // process lifecycle, so the in-page restart affordance is hidden there.
        const desktopView = new URLSearchParams(location.search).get('desktop') === '1';
        if (restartBtn && !desktopView) {
            restartBtn.addEventListener('click', () => this._openRestartModal());
        }
        else if (restartBtn) {
            restartBtn.style.display = 'none';
        }
        if (this.restartModalClose) {
            this.restartModalClose.addEventListener('click', () => this._closeRestartModal());
        }
        if (this.restartModalCancel) {
            this.restartModalCancel.addEventListener('click', () => this._closeRestartModal());
        }
        if (this.restartModal) {
            this.restartModal.addEventListener('click', (e) => {
                if (e.target === this.restartModal)
                    this._closeRestartModal();
            });
        }
        if (this.restartModalConfirm) {
            this.restartModalConfirm.addEventListener('click', () => this._doRestart());
        }
        // Paste-from-clipboard modal wires. Each handler reads/writes
        // _pastePending and _pasteConflict so a double-click on Save can't
        // double-POST, and so the second POST after a 409 carries
        // overwrite:true.
        if (this.pasteModalClose) {
            this.pasteModalClose.addEventListener('click', () => this._closePasteModal());
        }
        if (this.pasteModalCancel) {
            this.pasteModalCancel.addEventListener('click', () => this._closePasteModal());
        }
        if (this.pasteModal) {
            this.pasteModal.addEventListener('click', (e) => {
                if (e.target === this.pasteModal)
                    this._closePasteModal();
            });
        }
        if (this.pasteModalForm) {
            this.pasteModalForm.addEventListener('submit', (e) => {
                e.preventDefault();
                this._submitPaste();
            });
        }
        // Filename edit clears the conflict state: if the user changes
        // the name after a 409, the next POST should be overwrite:false.
        if (this.pasteModalName) {
            this.pasteModalName.addEventListener('input', () => {
                if (this._pasteConflict) {
                    this._pasteConflict = false;
                    this.pasteModalSave.textContent = 'Save';
                    this._setPasteError('');
                }
            });
        }
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (!this.modal.classList.contains('hidden')) {
                    this.closeModal();
                }
                else if (this.restartModal &&
                    !this.restartModal.classList.contains('hidden')) {
                    this._closeRestartModal();
                }
                else if (this.pasteModal &&
                    !this.pasteModal.classList.contains('hidden')) {
                    this._closePasteModal();
                }
                this._hideContextMenu();
            }
        });
        document.addEventListener('click', (e) => {
            if (this.contextMenuEl &&
                !e.target.closest('.md-context-menu') &&
                !e.target.closest('.md-file-action-btn')) {
                this._hideContextMenu();
            }
        });
    }
    // refreshFiles re-scans the markdown dirs for the active cwd.
    //   force  (default true): bypass the panel-visibility gate.
    //   silent (default false): no "Scanning..." placeholder, and skip the
    //     re-render when the fetched list is identical to what's shown —
    //     this is what background triggers (fsnotify push, same-context
    //     tab clicks) use so the list never flickers under the user.
    async refreshFiles(options = {}) {
        const force = options.force !== false;
        const silent = options.silent === true;
        const diffCtrl = this.app.diffController;
        if (!force &&
            diffCtrl &&
            (!diffCtrl.isPanelOpen || diffCtrl.activeTab !== 'markdown')) {
            return;
        }
        const cwd = this.app.sessionsManager.activeCWD || '';
        const requestId = ++this.refreshRequestId;
        if (!silent) {
            this.fileListEl.innerHTML =
                '<div class="md-list-loading">Scanning...</div>';
        }
        try {
            const res = await fetch(`/api/markdown/files?cwd=${encodeURIComponent(cwd)}`);
            if (!res.ok)
                throw new Error(await res.text());
            const files = await res.json();
            if (requestId !== this.refreshRequestId)
                return;
            const key = cwd + ' ' + JSON.stringify(files);
            if (silent && key === this._lastRenderedKey)
                return;
            this._lastRenderedKey = key;
            this._renderFileList(files);
        }
        catch (e) {
            if (requestId !== this.refreshRequestId)
                return;
            if (!silent) {
                this.fileListEl.innerHTML = `<div class="md-list-error">Failed to load: ${escapeHtml(e.message)}</div>`;
            }
        }
    }
    // onExternalChange handles a 0x07 md-changed push. N open tabs mean N
    // duplicate broadcasts per change, hence the debounce. The dir filter
    // drops events for worktrees this browser isn't looking at.
    onExternalChange(data = {}) {
        const cwd = this.app.sessionsManager.activeCWD || '';
        if (data.dir && cwd) {
            const dirs = (this.app.markdownDirs || []).map((d) => {
                if (d === '.' || d === './')
                    return cwd;
                if (d.startsWith('/') || /^[A-Za-z]:[\\/]/.test(d))
                    return d;
                return cwd.replace(/\/+$/, '') + '/' + d.replace(/^\.\//, '');
            });
            if (!dirs.some((d) => normalizePath(d) === normalizePath(data.dir)))
                return;
        }
        if (this._externalDebounce)
            clearTimeout(this._externalDebounce);
        this._externalDebounce = setTimeout(() => {
            this._externalDebounce = null;
            this.refreshFiles({ force: false, silent: true });
        }, 250);
    }
    _renderFileList(files) {
        this.fileListEl.innerHTML = '';
        const allDirs = this.app.markdownDirs || [];
        const byDir = {};
        allDirs.forEach((d) => {
            byDir[d] = [];
        });
        if (files && files.length > 0) {
            files.forEach((f) => {
                if (!byDir[f.dir])
                    byDir[f.dir] = [];
                byDir[f.dir].push(f);
            });
        }
        if (Object.keys(byDir).length === 0) {
            this.fileListEl.innerHTML =
                '<div class="md-list-empty">No markdown directories configured.</div>';
        }
        else {
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
                                body: JSON.stringify({ dir }),
                            });
                            await this.app.sessionsManager.loadConfig(); // Refresh cache!
                            this.refreshFiles();
                        }
                        catch (err) {
                            console.error('Failed to delete markdown dir:', err);
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
                }
                else {
                    dirFiles.forEach((f) => {
                        const row = document.createElement('div');
                        row.className = 'md-file-row';
                        const item = document.createElement('button');
                        item.className = 'md-file-item';
                        // Standard lucide-style 'file' icon. Universal render,
                        // no font dependency (the prior 𓏛 hieroglyph depended
                        // on a system font that some users didn't have).
                        // Decorative scroll/hieroglyph styling lives in the
                        // markdown VIEWER modal header instead, where it has
                        // room to breathe and a font fallback is acceptable.
                        item.innerHTML = `<svg class="md-file-icon md-file-icon-doc" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="8" y1="13" x2="16" y2="13"></line><line x1="8" y1="17" x2="13" y2="17"></line></svg><span class="md-file-name">${escapeHtml(f.name)}</span>`;
                        item.title = f.path;
                        item.addEventListener('click', (e) => {
                            if (e.ctrlKey || e.metaKey) {
                                e.preventDefault();
                                this._insertRelativePath(f);
                            }
                            else {
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
        // Bottom row: single Paste + Add Dir. Export/Import PHIMD bundle
        // removed — single-file copy/paste uses "# rel/path.md" header.
        const manageRow = document.createElement('div');
        manageRow.className = 'md-manage-row';
        const pasteBtn = document.createElement('button');
        pasteBtn.className = 'md-manage-btn';
        pasteBtn.id = 'md-paste-btn';
        pasteBtn.innerText = '📋 Paste Markdown With Filename';
        pasteBtn.title =
            'Paste Markdown With Filename (expects "# path/to/file.md" header)';
        pasteBtn.addEventListener('click', () => this._pasteFromSystemClipboard());
        manageRow.appendChild(pasteBtn);
        const addDirBtn = document.createElement('button');
        addDirBtn.className = 'md-manage-btn';
        addDirBtn.innerText = '+ Add Dir';
        addDirBtn.addEventListener('click', () => this._promptAddDir());
        manageRow.appendChild(addDirBtn);
        this.fileListEl.appendChild(manageRow);
    }
    // _setModalTitle renders the modal title with a stylized papyrus-scroll
    // SVG glyph on the left and the file name as text. Uses pure SVG paths
    // (no font dependency, unlike the prior 𓏛 hieroglyph in the file list).
    // Glow + accent color come from existing tokens — no new tokens per
    // AGENTS.md.
    _setModalTitle(name) {
        const scrollSvg = `<svg class="md-modal-scroll" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <ellipse cx="5" cy="16" rx="2.5" ry="9"/>
            <ellipse cx="27" cy="16" rx="2.5" ry="9"/>
            <path d="M 5 8 Q 16 5 27 8 L 27 24 Q 16 27 5 24 Z"/>
            <line x1="13" y1="5.2" x2="13" y2="2.8"/>
            <line x1="19" y1="5.2" x2="19" y2="2.8"/>
            <line x1="13" y1="26.8" x2="13" y2="29.2"/>
            <line x1="19" y1="26.8" x2="19" y2="29.2"/>
            <line x1="11" y1="13" x2="21" y2="13" stroke-width="0.9" opacity="0.55"/>
            <line x1="11" y1="16" x2="20" y2="16" stroke-width="0.9" opacity="0.55"/>
            <line x1="11" y1="19" x2="21" y2="19" stroke-width="0.9" opacity="0.55"/>
        </svg>`;
        this.modalTitle.innerHTML = `${scrollSvg}<span class="md-modal-title-text">${escapeHtml(name)}</span>`;
    }
    async openFile(f) {
        const cwd = this.app.sessionsManager.activeCWD || '';
        this._setModalTitle(f.name);
        this.modalBody.innerHTML =
            '<div class="md-rendering">Rendering...</div>';
        this.modal.classList.remove('hidden');
        this.currentRawContent = '';
        try {
            const res = await fetch(`/api/markdown/file?path=${encodeURIComponent(f.path)}&cwd=${encodeURIComponent(cwd)}`);
            if (!res.ok)
                throw new Error(await res.text());
            const raw = await res.text();
            this.currentRawContent = raw;
            const html = renderMarkdownSafe(raw);
            this.modalBody.innerHTML = `<div class="md-rendered">${html}</div>`;
            rewriteRelativeImages(this.modalBody, f.path, cwd);
            highlightCodeIn(this.modalBody);
        }
        catch (e) {
            this.modalBody.innerHTML = `<div class="md-list-error">Failed to load: ${escapeHtml(e.message)}</div>`;
        }
    }
    closeModal() {
        this.modal.classList.add('hidden');
        this.modalBody.innerHTML = '';
        this.currentRawContent = '';
    }
    _openRestartModal() {
        if (this.restartModal)
            this.restartModal.classList.remove('hidden');
    }
    _closeRestartModal() {
        if (this.restartModal)
            this.restartModal.classList.add('hidden');
    }
    async _doRestart() {
        if (this.restartModalConfirm) {
            this.restartModalConfirm.disabled = true;
            this.restartModalConfirm.textContent = 'Restarting…';
        }
        if (this.restartModalCancel)
            this.restartModalCancel.disabled = true;
        try {
            const res = await fetch('/api/restart', { method: 'POST' });
            if (!res.ok) {
                const errText = await res.text().catch(() => 'unknown error');
                throw new Error(errText || `HTTP ${res.status}`);
            }
            // The 0x05 frame from /api/restart will fire handleServerShutdown
            // which shows its own toast and reloads the page. Nothing to do here.
        }
        catch (err) {
            this.app.showToast(`Restart failed: ${err.message}`, {
                type: 'error',
            });
            if (this.restartModalConfirm) {
                this.restartModalConfirm.disabled =
                    false;
                this.restartModalConfirm.textContent = 'Restart';
            }
            if (this.restartModalCancel)
                this.restartModalCancel.disabled = false;
        }
    }
    openRawMarkdown(title, rawMarkdown) {
        this.modalTitle.innerText = title;
        this.currentRawContent = rawMarkdown;
        const html = renderMarkdownSafe(rawMarkdown);
        this.modalBody.innerHTML = `<div class="md-rendered">${html}</div>`;
        highlightCodeIn(this.modalBody);
        this.modal.classList.remove('hidden');
    }
    async openHelpModal() {
        this.modalTitle.innerText = 'Phi Documentation';
        this.modalBody.innerHTML =
            '<div class="md-rendering">Loading help...</div>';
        this.currentRawContent = '';
        this.modal.classList.remove('hidden');
        try {
            const res = await fetch('help.md');
            if (!res.ok)
                throw new Error((await res.text()) || 'Failed to load help.md');
            const raw = await res.text();
            this.openRawMarkdown('Phi Documentation', raw);
        }
        catch (e) {
            this.modalBody.innerHTML = `<div class="md-list-error">Failed to load help: ${escapeHtml(e.message)}</div>`;
            this.app.showToast(`Failed to open help: ${e.message}`, {
                type: 'error',
                title: 'Help',
            });
        }
    }
    // openDiagModal — Phase 10: server diagnostics panel. Hits /api/diag
    // and renders a structured table (version, goroutines, mem, PTYs).
    // Useful for F4 debugging (hub overflow, slow client) and for ops
    // to verify the server is healthy from the browser. Auto-refreshes
    // every 2s while open.
    async openDiagModal() {
        this.modalTitle.innerText = 'Phi Diagnostics';
        this.modalBody.innerHTML =
            '<div class="md-rendering">Loading diagnostics…</div>';
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
            const body = rows
                .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(String(v))}</td></tr>`)
                .join('');
            const panes = (d.panes || [])
                .map((p) => {
                const pct = p.ring_capacity > 0
                    ? Math.round((p.ring_bytes * 100) / p.ring_capacity)
                    : 0;
                return `<tr>
                    <td>${escapeHtml(p.title || p.id.slice(0, 8))}</td>
                    <td>${escapeHtml(p.coder || '—')}</td>
                    <td>${p.client_count}</td>
                    <td>${p.ring_bytes}/${p.ring_capacity} (${pct}%)</td>
                    <td>${p.busy ? 'busy' : 'idle'}</td>
                </tr>`;
            })
                .join('');
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
                if (!res.ok)
                    throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                render(data);
            }
            catch (err) {
                this.modalBody.innerHTML = `<div class="md-list-error">Failed: ${escapeHtml(err.message)}</div>`;
            }
        };
        await refresh();
        if (this._diagInterval)
            clearInterval(this._diagInterval);
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
        const version = ((versionEl && versionEl.textContent) || '').trim();
        const title = version ? `Changelog — ${version}` : 'Changelog';
        this.modalTitle.innerText = title;
        this.modalBody.innerHTML =
            '<div class="md-rendering">Loading changelog...</div>';
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
            const res = await fetch('changelog.md');
            if (!res.ok)
                throw new Error((await res.text()) || 'Failed to load changelog.md');
            const raw = await res.text();
            this.openRawMarkdown(title, raw);
        }
        catch (e) {
            this.modalBody.innerHTML = `<div class="md-list-error">Failed to load changelog: ${escapeHtml(e.message)}</div>`;
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
        if (!status || !status.update_available || status.current === 'dev')
            return null;
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
        if (status.install_method === 'npm' ||
            status.install_method === 'standalone') {
            const actions = document.createElement('div');
            actions.className = 'update-banner-actions';
            const applyBtn = document.createElement('button');
            applyBtn.className = 'update-banner-btn';
            applyBtn.textContent = `Apply & restart next time`;
            applyBtn.title =
                'Stage the binary. phi restarts into it next time it restarts (manual: Ctrl+C + relaunch).';
            applyBtn.addEventListener('click', () => this._startUpdateApply(status.latest, applyBtn, banner));
            actions.appendChild(applyBtn);
            // Phase 9 T3: 'Apply & restart now' chains the staged swap
            // with an immediate server restart. Disabled for npm because
            // the npm shim owns the child lifecycle; restarting the
            // server mid-update leaves the shim in a weird state. Plan
            // §3.5 'npm-shim consideration'.
            if (status.install_method === 'standalone') {
                const restartBtn = document.createElement('button');
                restartBtn.className =
                    'update-banner-btn update-banner-btn-restart';
                restartBtn.textContent = 'Apply & restart now';
                restartBtn.title =
                    'Stage the binary and immediately restart phi. Browser will reload.';
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
                body: JSON.stringify({ version }),
            });
            if (!res.ok) {
                const errText = await res.text();
                throw new Error(errText || `HTTP ${res.status}`);
            }
        }
        catch (err) {
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
                if (!r.ok)
                    throw new Error(`HTTP ${r.status}`);
                const p = await r.json();
                progressEl.textContent = this._formatProgress(p);
                progressEl.classList.toggle('error', p.phase === 'error');
                if (p.phase === 'done' || p.phase === 'error') {
                    if (p.phase === 'done') {
                        btn.textContent = `Staged ${version} — restart into it`;
                        this.app.showToast(`Update staged. Restart phi to apply ${version}.`, { type: 'success' });
                    }
                    else {
                        btn.disabled = false;
                        btn.textContent = `Retry apply`;
                    }
                    return;
                }
            }
            catch (err) {
                progressEl.textContent = `polling: ${err.message}`;
            }
            setTimeout(poll, pollIntervalMs);
        };
        setTimeout(poll, pollIntervalMs);
    }
    _formatProgress(p) {
        if (!p || !p.phase)
            return '';
        switch (p.phase) {
            case 'downloading':
                return `Downloading… ${p.pct}%`;
            case 'verifying':
                return 'Verifying checksum…';
            case 'extracting':
                return 'Extracting binary…';
            case 'staging':
                return 'Staging swap…';
            case 'done':
                return `Staged. Old binary kept at ${p.old_path || 'phi.old'}.`;
            case 'error':
                return `Error: ${p.error || 'unknown'}`;
            default:
                return p.phase;
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
        if (progressEl)
            progressEl.textContent = 'staging…';
        // Trigger the apply and poll.
        try {
            const res = await fetch('/api/update/apply', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ version }),
            });
            if (!res.ok)
                throw new Error((await res.text()) || `HTTP ${res.status}`);
        }
        catch (err) {
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
            if (!r.ok)
                throw new Error(`HTTP ${r.status}`);
            const p = await r.json();
            if (progressEl) {
                progressEl.textContent = this._formatProgress(p);
                progressEl.classList.toggle('error', p.phase === 'error');
            }
            if (p.phase === 'done')
                return true;
            if (p.phase === 'error')
                throw new Error(p.error || 'staging failed');
            return false;
        };
        try {
            for (;;) {
                if (await waitForStaged())
                    break;
                await new Promise((r) => setTimeout(r, 500));
            }
        }
        catch (err) {
            restartBtn.disabled = false;
            applyBtn.disabled = false;
            restartBtn.textContent = 'Apply & restart now';
            return;
        }
        // Staged. Now restart. The 0x05 frame will arm the reload poller;
        // we ALSO trigger the reload as a backup (in case the WS isn't
        // connected). Best-effort; ignore errors since the page is dying.
        restartBtn.textContent = 'Restarting…';
        if (progressEl)
            progressEl.textContent = 'staged, restarting…';
        try {
            await fetch('/api/restart', { method: 'POST' });
        }
        catch (_) {
            // Server is dying; expected.
        }
        // Hard reload fallback in case the WS-driven reload doesn't fire
        // within a couple of seconds (network blip, browser backgrounded).
        setTimeout(() => window.location.reload(), 2500);
    }
    async _promptAddDir() {
        const dir = prompt('Add markdown directory (relative to workspace, e.g. ./docs):');
        if (!dir || !dir.trim())
            return;
        try {
            await fetch('/api/config/markdown-dirs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ dir: dir.trim() }),
            });
            await this.app.sessionsManager.loadConfig(); // Refresh cache!
            this.refreshFiles();
        }
        catch (e) {
            console.error('Failed to add markdown dir:', e);
        }
    }
    _createContextMenu() {
        const menu = document.createElement('div');
        menu.className = 'md-context-menu hidden';
        document.body.appendChild(menu);
        return menu;
    }
    _showContextMenu(file, anchorEl) {
        if (!this.contextMenuEl)
            return;
        this.contextMenuEl.innerHTML = '';
        const actions = [
            {
                icon: '@',
                label: 'Insert @path',
                className: 'insert-path',
                handler: () => this._insertRelativePath(file, { mention: true }),
            },
            {
                icon: '↗',
                label: 'Open in new window',
                className: 'open-window',
                handler: () => this._openInNewWindow(file),
            },
            {
                icon: '⧉',
                label: 'Copy',
                className: 'copy',
                handler: () => this._copyMarkdownFile(file),
            },
            {
                icon: '⧉',
                label: 'Copy Markdown With Filename',
                className: 'copy-blob',
                handler: () => this._copyMarkdownBlob(file),
            },
            {
                icon: '⇉',
                label: 'Copy to all worktrees',
                className: 'copy-all',
                handler: () => this._copyMarkdownFileToAllWorktrees(file),
            },
            {
                icon: '⇩',
                label: 'Paste…',
                className: 'paste',
                handler: () => this._pasteMarkdownFile(file),
            },
            {
                icon: '🗑',
                label: 'Delete…',
                className: 'delete',
                handler: () => this._deleteMarkdownFile(file),
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
    _openInNewWindow(f) {
        const cwd = this.app.sessionsManager.activeCWD || '';
        // Desktop host claim (Tier 1): phi-desktop opens a real native
        // window for the same path/cwd; in a plain browser tryNative is a
        // no-op returning false and the window.open fallback below runs.
        if (tryNative('markdown', { path: f.path, cwd }))
            return;
        const url = `/md.html?path=${encodeURIComponent(f.path)}&cwd=${encodeURIComponent(cwd)}`;
        // No 'noopener' in features: the spec makes window.open return null
        // when noopener is set, which would defeat popup-blocked detection.
        // Same-origin page; sever the back-reference manually instead.
        const win = window.open(url, '_blank', 'width=860,height=1000');
        if (win) {
            win.opener = null;
        }
        else
            this.app.showToast('Popup blocked — allow popups for this site.', {
                type: 'error',
            });
    }
    async _copyMarkdownFile(file) {
        try {
            const cwd = this.app.sessionsManager.activeCWD || '';
            const res = await fetch(`/api/markdown/file?path=${encodeURIComponent(file.path)}&cwd=${encodeURIComponent(cwd)}`);
            if (!res.ok)
                throw new Error(await res.text());
            const content = await res.text();
            this.markdownClipboard = {
                name: file.name,
                dir: file.dir,
                content,
            };
            this.app.showToast(`Copied "${file.name}"`, {
                type: 'info',
                title: 'Markdown Clipboard',
            });
        }
        catch (e) {
            this.app.showToast(`Failed to copy file: ${e.message}`, {
                type: 'error',
                title: 'Markdown Clipboard',
            });
        }
    }
    async _copyMarkdownBlob(file) {
        try {
            const cwd = this.app.sessionsManager.activeCWD || '';
            const res = await fetch(`/api/markdown/file?path=${encodeURIComponent(file.path)}&cwd=${encodeURIComponent(cwd)}`);
            if (!res.ok)
                throw new Error(await res.text());
            const content = await res.text();
            const relPath = relativeToCwd(file.path, cwd) || file.name;
            const payload = `# ${relPath}\n${content}`;
            await this._copyToClipboard(payload, `Copied "${relPath}" to clipboard`);
        }
        catch (e) {
            this.app.showToast(`Failed to copy file: ${e.message}`, {
                type: 'error',
                title: 'Markdown Clipboard',
            });
        }
    }
    async _copyMarkdownFileToAllWorktrees(file) {
        try {
            const cwd = this.app.sessionsManager.activeCWD || '';
            const res = await fetch('/api/markdown/copy-all-worktrees', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cwd, dir: file.dir, path: file.path }),
            });
            if (!res.ok)
                throw new Error(await res.text());
            const result = await res.json();
            this.app.showToast(`Copied "${file.name}" to ${result.copied} worktree(s)`, { type: 'info', title: 'Markdown' });
        }
        catch (e) {
            this.app.showToast(`Failed to copy to worktrees: ${e.message}`, { type: 'error', title: 'Markdown' });
        }
    }
    async _pasteMarkdownFile(file) {
        if (!this.markdownClipboard) {
            this.app.showToast('Nothing copied yet', {
                type: 'error',
                title: 'Markdown Clipboard',
            });
            return;
        }
        const suggested = this.markdownClipboard.name;
        let name = prompt('Paste as filename:', suggested);
        if (!name || !name.trim())
            return;
        name = name.trim();
        const doPaste = async (overwrite = false) => {
            const cwd = this.app.sessionsManager.activeCWD || '';
            const res = await fetch('/api/markdown/paste', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    cwd,
                    dir: file.dir,
                    name,
                    content: this.markdownClipboard.content,
                    overwrite,
                }),
            });
            if (res.status === 409 && !overwrite) {
                if (confirm(`"${name}" already exists. Overwrite it?`)) {
                    return doPaste(true);
                }
                return;
            }
            if (!res.ok)
                throw new Error(await res.text());
            this.app.showToast(`Pasted as "${name}"`, {
                type: 'info',
                title: 'Markdown Clipboard',
            });
            await this.refreshFiles();
        };
        try {
            await doPaste(false);
        }
        catch (e) {
            this.app.showToast(`Failed to paste file: ${e.message}`, { type: 'error', title: 'Markdown Clipboard' });
        }
    }
    // _pasteFromSystemClipboard implements the single Paste button.
    // It reads the OS clipboard, expects the first line to be
    // "# temp/A.md" (relative path, no leading ./), and writes the
    // remaining content to that path under activeCWD. If the target
    // directory does not exist, the backend returns a simple error.
    // On 409 (file exists) it confirms overwrite before retrying.
    async _pasteFromSystemClipboard() {
        const dirs = this.app.markdownDirs || [];
        if (dirs.length === 0) {
            this.app.showToast('Add a markdown directory in Settings first', {
                type: 'error',
                title: 'Markdown',
            });
            return;
        }
        let text = '';
        try {
            if (typeof navigator !== 'undefined' &&
                navigator.clipboard &&
                window
                    .isSecureContext !== false &&
                navigator.clipboard.readText) {
                text = await navigator.clipboard.readText();
            }
            else {
                const fallback = await this._readClipboardViaUserPaste();
                if (fallback === null)
                    return;
                text = fallback;
            }
        }
        catch (err) {
            console.warn('[md] clipboard read blocked', err);
            // Fallback to user-gesture paste capture (works on insecure http:// LAN)
            const fallback = await this._readClipboardViaUserPaste();
            if (fallback === null) {
                this.app.showToast('Failed to read clipboard', {
                    type: 'error',
                    title: 'Markdown',
                });
                return;
            }
            text = fallback;
        }
        if (!text || !text.trim()) {
            this.app.showToast('Clipboard is empty', {
                type: 'error',
                title: 'Markdown',
            });
            return;
        }
        const firstNewline = text.indexOf('\n');
        const firstLine = (firstNewline === -1 ? text : text.slice(0, firstNewline)).trim();
        if (!firstLine.startsWith('#')) {
            this.app.showToast('Clipboard does not start with "# path/to/file.md"', {
                type: 'error',
                title: 'Markdown',
            });
            return;
        }
        let relPath = firstLine.slice(1).trim();
        // Normalize: strip leading ./ and leading /
        relPath = relPath.replace(/^\.\//, '').replace(/^\/+/, '');
        if (!relPath) {
            this.app.showToast('Invalid path in clipboard header', {
                type: 'error',
                title: 'Markdown',
            });
            return;
        }
        // Ensure .md extension for safety (paste target is markdown)
        if (!relPath.toLowerCase().endsWith('.md')) {
            relPath += '.md';
        }
        const lastSlash = relPath.lastIndexOf('/');
        let dir;
        let name;
        if (lastSlash === -1) {
            dir = '.';
            name = relPath;
        }
        else {
            dir = relPath.slice(0, lastSlash) || '.';
            name = relPath.slice(lastSlash + 1);
        }
        if (!name || name === '.md') {
            this.app.showToast('Invalid filename in clipboard header', {
                type: 'error',
                title: 'Markdown',
            });
            return;
        }
        let content = firstNewline === -1 ? '' : text.slice(firstNewline + 1);
        // Strip one leading newline if the copy used "# rel\ncontent"
        if (content.startsWith('\r\n'))
            content = content.slice(2);
        else if (content.startsWith('\n'))
            content = content.slice(1);
        const cwd = this.app.sessionsManager.activeCWD || '';
        const doPaste = async (overwrite) => {
            return fetch('/api/markdown/paste', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cwd, dir, name, content, overwrite }),
            });
        };
        try {
            let res = await doPaste(false);
            if (res.status === 409) {
                const ok = confirm(`"${relPath}" already exists. Overwrite it?`);
                if (!ok)
                    return;
                res = await doPaste(true);
            }
            if (!res.ok) {
                const msg = (await res.text()) || `HTTP ${res.status}`;
                throw new Error(msg);
            }
            this.app.showToast(`Pasted to "${relPath}"`, {
                type: 'info',
                title: 'Markdown',
            });
            await this.refreshFiles();
        }
        catch (e) {
            this.app.showToast(`Paste failed: ${e.message}`, {
                type: 'error',
                title: 'Markdown',
            });
        }
    }
    // Fallback for insecure contexts (http:// on LAN where clipboard.readText is blocked).
    // Shows a textarea overlay that captures the next Ctrl+V via the paste event
    // (clipboardData.getData('text')) or via textarea value — works without
    // navigator.clipboard. Resolves with the pasted string or null on cancel.
    _readClipboardViaUserPaste() {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';
            overlay.style.zIndex = '10001';
            overlay.innerHTML = `
                <div class="modal" style="max-width:560px">
                    <h3 style="margin:0 0 8px">Paste markdown clipboard</h3>
                    <p style="margin:0 0 8px;opacity:0.8;font-size:13px">Clipboard API is blocked on this connection (plain http). Press <kbd>Ctrl</kbd>+<kbd>V</kbd> to paste — first line must be <code># path/to/file.md</code></p>
                    <textarea id="md-system-paste-input" style="width:100%;height:180px;font-family:monospace;font-size:13px" placeholder="# temp/A.md
# heading
body..."></textarea>
                    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">
                        <button type="button" id="md-system-paste-cancel" class="btn">Cancel</button>
                        <button type="button" id="md-system-paste-confirm" class="btn btn-accent">Paste</button>
                    </div>
                </div>`;
            document.body.appendChild(overlay);
            const ta = overlay.querySelector('#md-system-paste-input');
            const cancelBtn = overlay.querySelector('#md-system-paste-cancel');
            const confirmBtn = overlay.querySelector('#md-system-paste-confirm');
            let done = false;
            const cleanup = () => {
                window.removeEventListener('paste', onWindowPaste);
                overlay.remove();
            };
            const finish = (val) => {
                if (done)
                    return;
                done = true;
                cleanup();
                resolve(val);
            };
            const onWindowPaste = (e) => {
                const data = e.clipboardData?.getData('text') ?? '';
                if (data) {
                    // Prevent double insert into textarea
                    e.preventDefault();
                    ta.value = data;
                    // let paste render then resolve
                    requestAnimationFrame(() => finish(data));
                }
            };
            window.addEventListener('paste', onWindowPaste);
            ta.focus({ preventScroll: true });
            // Clicking outside modal cancels
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay)
                    finish(null);
            });
            cancelBtn.addEventListener('click', () => finish(null));
            confirmBtn.addEventListener('click', () => {
                const v = ta.value;
                finish(v ? v : null);
            });
            ta.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    finish(null);
                }
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    e.preventDefault();
                    finish(ta.value || null);
                }
            });
            // If user pastes via context menu into textarea, Confirm will pick it up;
            // also auto-resolve shortly after any paste into textarea
            ta.addEventListener('paste', () => {
                setTimeout(() => {
                    if (!done && ta.value.trim()) {
                        // Don't auto-close: let user review + press Paste
                        // but if they pasted header+body we can hint
                    }
                }, 50);
            });
        });
    }
    // _openPasteModal fills the static #md-paste-modal from a clean state
    // every call. The dir field is rendered as a read-only text label
    // when exactly one directory is configured (the common case) and as
    // a <select> when more than one. The default filename is local-time
    // `pasted-YYYY-MM-DD-HHmmss.md` so two clicks in the same minute are
    // rare; the 409 overwrite flow handles the residual collision.
    _openPasteModal(opts) {
        const dirs = this.app.markdownDirs || [];
        if (dirs.length === 0) {
            // Race: directories cleared between button click and modal open.
            this.app.showToast('No markdown directory configured', {
                type: 'error',
                title: 'Markdown',
            });
            return;
        }
        this._pastePending = false;
        this._pasteConflict = false;
        this._setPasteError('');
        this.pasteModalSave.disabled = false;
        this.pasteModalSave.textContent = 'Save';
        this.pasteModalHint.textContent = opts.hint;
        this.pasteModalContent.value = opts.content;
        this.pasteModalName.value = this._defaultPasteFilename();
        // Dir field: text label (single) or <select> (multiple). The
        // active directory is whichever option the user picks; the
        // backend validates membership in markdownDirs server-side.
        this.pasteModalDir.innerHTML = '';
        if (dirs.length === 1) {
            const span = document.createElement('span');
            span.textContent = dirs[0];
            this.pasteModalDir.appendChild(span);
            this.pasteModalDirLabel.textContent = 'Target directory';
        }
        else {
            const select = document.createElement('select');
            select.id = 'md-paste-modal-dir-select';
            // html-validate wants <label for=...> to point at a labelable
            // form control, but the target here is a <div> that may be
            // either text or a <select>. Drop it on the <label> and
            // bridge with aria-labelledby instead.
            select.setAttribute('aria-labelledby', 'md-paste-modal-dir-label');
            dirs.forEach((d) => {
                const opt = document.createElement('option');
                opt.value = d;
                opt.textContent = d;
                select.appendChild(opt);
            });
            this.pasteModalDir.appendChild(select);
            this.pasteModalDirLabel.textContent = `Target directory (${dirs.length} configured)`;
        }
        this.pasteModal.classList.remove('hidden');
        if (opts.focusContent) {
            this.pasteModalContent.focus({ preventScroll: true });
        }
        else {
            this.pasteModalName.focus({ preventScroll: true });
            this.pasteModalName.select();
        }
    }
    // _defaultPasteFilename returns `pasted-YYYY-MM-DD-HHmmss.md` in local
    // time. Seconds resolution makes a same-minute double-paste rare; if
    // it does collide, the 409 overwrite flow catches it.
    _defaultPasteFilename() {
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const yyyy = now.getFullYear();
        const mm = pad(now.getMonth() + 1);
        const dd = pad(now.getDate());
        const hh = pad(now.getHours());
        const mi = pad(now.getMinutes());
        const ss = pad(now.getSeconds());
        return `pasted-${yyyy}-${mm}-${dd}-${hh}${mi}${ss}.md`;
    }
    // _selectedPasteDir returns the directory the user picked. Falls back
    // to dirs[0] for the single-dir case where there is no <select>.
    _selectedPasteDir() {
        const dirs = this.app.markdownDirs || [];
        if (dirs.length === 1)
            return dirs[0];
        const select = this.pasteModalDir.querySelector('select');
        return select && select.value ? select.value : dirs[0] || '';
    }
    _setPasteError(msg) {
        this.pasteModalError.textContent = msg;
    }
    // _submitPaste is the form-submit path. It reads the modal fields,
    // validates non-empty content + sane filename, then POSTs to
    // /api/markdown/paste. On 409 it transitions the Save button to
    // "Overwrite" and the next submit sends overwrite:true. On any other
    // failure it surfaces the server's text in the inline error and
    // re-enables Save. On success it closes the modal, refreshes, and
    // toasts the server-returned normalized filename (the user may have
    // typed "notes" but the file is "notes.md").
    async _submitPaste() {
        if (this._pastePending)
            return;
        const content = this.pasteModalContent.value;
        const nameRaw = this.pasteModalName.value.trim();
        if (!content || !content.trim()) {
            this._setPasteError('Content is empty.');
            this.pasteModalContent.focus({ preventScroll: true });
            return;
        }
        if (!nameRaw) {
            this._setPasteError('Filename is required.');
            this.pasteModalName.focus({ preventScroll: true });
            return;
        }
        if (/[\\/]/.test(nameRaw)) {
            // Backend's filepath.Base would silently strip the path;
            // surface it instead so the user knows the name they typed
            // isn't what they'll get.
            this._setPasteError('Filename cannot contain path separators.');
            this.pasteModalName.focus({ preventScroll: true });
            return;
        }
        const overwrite = this._pasteConflict;
        const name = nameRaw.endsWith('.md') || nameRaw.toLowerCase().endsWith('.md')
            ? nameRaw
            : `${nameRaw}.md`;
        const dir = this._selectedPasteDir();
        this._pastePending = true;
        this.pasteModalSave.disabled = true;
        this._setPasteError('');
        try {
            const cwd = this.app.sessionsManager.activeCWD || '';
            const res = await fetch('/api/markdown/paste', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cwd, dir, name, content, overwrite }),
            });
            if (res.status === 409 && !overwrite) {
                // File exists: transition Save -> Overwrite without closing
                // the modal. Next submit retries with overwrite:true.
                this._pasteConflict = true;
                this.pasteModalSave.textContent = 'Overwrite';
                this._setPasteError(`"${name}" already exists. Click Overwrite to replace it.`);
                this._pastePending = false;
                this.pasteModalSave.disabled = false;
                return;
            }
            if (!res.ok) {
                const text = await res.text();
                throw new Error(text || `HTTP ${res.status}`);
            }
            const data = await res.json().catch(() => ({}));
            const savedName = (data && data.name) || name;
            // Clear pending BEFORE _closePasteModal: the close guard
            // refuses to close while a request is in flight, and we are
            // past the request.
            this._pastePending = false;
            this._closePasteModal();
            this.app.showToast(`Pasted as "${savedName}"`, {
                type: 'info',
                title: 'Markdown',
            });
            await this.refreshFiles();
        }
        catch (e) {
            // Keep modal open, surface the error inline. Save re-enabled
            // so the user can correct and retry.
            this._setPasteError(e.message || 'Paste failed');
            this._pastePending = false;
            this.pasteModalSave.disabled = false;
        }
    }
    _closePasteModal() {
        if (this._pastePending)
            return; // don't yank the modal mid-request
        this.pasteModal.classList.add('hidden');
        this._setPasteError('');
    }
    async _deleteMarkdownFile(file) {
        if (!confirm(`Delete markdown file "${file.name}"?`))
            return;
        try {
            const cwd = this.app.sessionsManager.activeCWD || '';
            const res = await fetch('/api/markdown/delete', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cwd, path: file.path }),
            });
            if (!res.ok)
                throw new Error(await res.text());
            this.app.showToast(`Deleted "${file.name}"`, {
                type: 'info',
                title: 'Markdown',
            });
            await this.refreshFiles();
        }
        catch (e) {
            this.app.showToast(`Failed to delete file: ${e.message}`, { type: 'error', title: 'Markdown' });
        }
    }
    // Inserts the file's cwd-relative path into the chat textarea at the
    // cursor. With { mention: true } the path is formatted for the active
    // tab's coder via ATTACHMENT_SYNTAX (claude → @path, bash → raw path);
    // without it the raw relative path is inserted (Ctrl/Cmd+click behavior,
    // unchanged).
    _insertRelativePath(f, opts = {}) {
        const cwd = this.app.sessionsManager.activeCWD || '';
        const relPath = relativeToCwd(f.path, cwd);
        let insertText = relPath;
        if (opts.mention) {
            const coder = this.app.tabManager?.getActiveTab?.()?.coder || '';
            insertText = formatAttachment(coder, {
                path: relPath,
            });
        }
        const textarea = document.getElementById('input-textarea');
        if (textarea) {
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
    }
    async _copyToClipboard(text, msg) {
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text);
            }
            else {
                const ta = Object.assign(document.createElement('textarea'), {
                    value: text,
                });
                ta.style.cssText = 'position:fixed;opacity:0';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                ta.remove();
            }
            this.app.showToast(msg, { type: 'info', title: 'Clipboard' });
        }
        catch (err) {
            this.app.showToast('Failed to copy content', { type: 'error' });
        }
    }
    // _exportMarkdownBundle asks the server to pack every .md file in
    // the configured markdownDirs, then copies the resulting PHIMD: blob
    // to the clipboard. Falls back to a paste-into-prompt path when the
    // Clipboard API is blocked.
    async _exportMarkdownBundle() {
        try {
            const cwd = this.app.sessionsManager.activeCWD || '';
            const res = await fetch('/api/markdown/export-bundle', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cwd }),
            });
            if (!res.ok)
                throw new Error(`export failed: ${res.status}`);
            const data = (await res.json());
            if (!data.blob) {
                this.app.showToast('No markdown files to export', {
                    type: 'info',
                });
                return;
            }
            await this._copyToClipboard(data.blob, `Exported ${data.count} markdown file${data.count === 1 ? '' : 's'} to clipboard`);
        }
        catch (err) {
            this.app.showToast(`Export failed: ${err.message}`, {
                type: 'error',
            });
        }
    }
    // _importMarkdownBundle reads a PHIMD: blob from the clipboard (or a
    // prompt fallback) and posts it to the server for safe decode +
    // path-validated write. Overwrite is opt-in via a confirm() so the
    // user doesn't silently clobber existing files by accident.
    async _importMarkdownBundle() {
        let blob = '';
        try {
            if (navigator.clipboard && navigator.clipboard.readText) {
                blob = await navigator.clipboard.readText();
            }
        }
        catch (err) {
            // Browser blocked clipboard read — fall through to prompt.
            console.warn('[md] clipboard read blocked', err);
        }
        if (!blob || !blob.trim()) {
            blob =
                typeof prompt === 'function'
                    ? prompt('Paste your markdown bundle here (starts with PHIMD:):') || ''
                    : '';
        }
        if (!blob || !blob.trim()) {
            this.app.showToast('No bundle text to import', { type: 'info' });
            return;
        }
        if (!blob.startsWith('PHIMD:')) {
            this.app.showToast('Clipboard does not contain a markdown bundle (expected PHIMD:…)', { type: 'error' });
            return;
        }
        const overwrite = typeof confirm === 'function'
            ? confirm('Overwrite existing files with the same name?\nClick Cancel to skip existing files (safe default).')
            : false;
        try {
            const cwd = this.app.sessionsManager.activeCWD || '';
            const res = await fetch('/api/markdown/import-bundle', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cwd, blob, overwrite }),
            });
            if (!res.ok) {
                const errText = await res.text();
                throw new Error(errText || `${res.status}`);
            }
            const data = (await res.json());
            const written = data.written?.length || 0;
            const skipped = data.skipped?.length || 0;
            this.app.showToast(`Imported ${written} file${written === 1 ? '' : 's'}` +
                (skipped ? `, skipped ${skipped}` : ''), { type: 'info', title: 'Markdown' });
            // Refresh the file list so newly written files appear.
            await this.refreshFiles({ force: true });
        }
        catch (err) {
            this.app.showToast(`Import failed: ${err.message}`, {
                type: 'error',
            });
        }
    }
}
