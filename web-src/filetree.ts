/* Φ phi — File tree (files tab in right panel) */

import type { AppLike } from './types.js';
import { formatAttachment, type Attachment } from './attachments.js';
import { escapeHtml } from './util.js';
import {
    buildVSCodeURI,
    buildVSCodeRemoteURI,
    normalizeHostname,
    isVSCodeLaunchUnsupported,
} from './vscode.js';

interface FSEntry {
    name: string;
    dir: boolean;
}
interface FSListResponse {
    truncated: boolean;
    entries: FSEntry[];
}

const FILE_ICON_SVG = `<svg class="md-file-icon md-file-icon-doc" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="8" y1="13" x2="16" y2="13"></line><line x1="8" y1="17" x2="13" y2="17"></line></svg>`;

// Compact inline SVG glyphs for the per-row VS Code actions. Explicit
// dimensions + stroke mirrors the markdown file-icon style.
const VSCODE_LOCAL_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><path d="M9 8l-4 4 4 4"></path><path d="M15 8l4 4-4 4"></path></svg>`;
const VSCODE_REMOTE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><path d="M5 12h14"></path><path d="M9 8l-4 4 4 4"></path><path d="M15 8l4 4-4 4"></path></svg>`;

export class FileTreeManager {
    app: AppLike;
    treeEl: HTMLElement;
    contextMenuEl: HTMLElement;
    expanded: Set<string>;
    refreshRequestId: number;
    toolbarEl: HTMLElement | null;
    localBtn: HTMLAnchorElement | null;
    remoteBtn: HTMLAnchorElement | null;
    vscodeUnsupported: boolean;

    constructor(app: AppLike) {
        this.app = app;
        this.treeEl = document.getElementById('file-tree-list')!;
        this.expanded = new Set();
        this.refreshRequestId = 0;
        this.contextMenuEl = this._createContextMenu();
        this.toolbarEl = document.getElementById('file-tree-toolbar');
        this.localBtn = document.getElementById(
            'ft-vscode-local-btn',
        ) as HTMLAnchorElement | null;
        this.remoteBtn = document.getElementById(
            'ft-vscode-remote-btn',
        ) as HTMLAnchorElement | null;
        // Hidden on surfaces that cannot dispatch vscode: (the desktop
        // main view + any embedded Electron view). The launch
        // helpers below still resolve URIs for tests, but the
        // buttons stay out of the DOM in that case.
        this.vscodeUnsupported = isVSCodeLaunchUnsupported();
        if (this.vscodeUnsupported) {
            this.toolbarEl?.remove();
            this.toolbarEl = null;
            this.localBtn = null;
            this.remoteBtn = null;
        }
        this._setupEventListeners();
    }

    _setupEventListeners(): void {
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this._hideContextMenu();
        });
        document.addEventListener('click', (e) => {
            if (
                this.contextMenuEl &&
                !(e.target as any).closest('.ft-context-menu') &&
                !(e.target as any).closest('.md-file-action-btn')
            ) {
                this._hideContextMenu();
            }
        });
    }

    // refresh re-renders the whole tree for the active cwd, refetching the
    // root and every expanded directory (no cache — freshness by refetch).
    // Callers are already gated on the files tab being visible (refreshDiff's
    // files branch and cwd changes). Folder expand/collapse does NOT come
    // through here — _toggleDir mutates the existing DOM incrementally, so
    // clicking a folder never flashes the panel or rebuilds unrelated rows.
    async refresh(): Promise<void> {
        const requestId = ++this.refreshRequestId;
        // Only an empty tree shows the loading splash. Re-fetching over
        // existing content swaps the new fragment in when it arrives; the
        // user keeps looking at the stale tree instead of a black flash.
        if (this.treeEl.children.length === 0) {
            this.treeEl.innerHTML =
                '<div class="md-list-loading">Loading...</div>';
        }
        // The toolbar buttons reflect the active CWD snapshot at fetch
        // start. Late responses don't reach here (the request counter
        // guards them), so we update the toolbar synchronously with
        // the same CWD we passed to the fetch.
        this._renderToolbar(this.app.sessionsManager?.activeCWD || '');
        try {
            const frag = await this._renderDir('', 0, requestId);
            if (requestId !== this.refreshRequestId || !frag) return;
            this.treeEl.replaceChildren(frag);
        } catch (e) {
            if (requestId !== this.refreshRequestId) return;
            this.treeEl.innerHTML = `<div class="md-list-error">Failed to load: ${escapeHtml((e as Error).message)}</div>`;
        }
    }

    /** Update the project-bar buttons to reflect the given root. Disabled
     *  state is set when the root is empty or non-absolute, or when the
     *  remote hostname is missing/invalid (local still works). Called
     *  with the CWD snapshot from refresh(); also exposed so callers
     *  can re-render after a server switch without a full refresh. */
    _renderToolbar(root: string): void {
        if (!this.toolbarEl || !this.localBtn || !this.remoteBtn) return;
        const localURI = buildVSCodeURI(root);
        const hostname = normalizeHostname(this.app.hostname);
        const remoteURI = buildVSCodeRemoteURI(hostname, {
            root,
            kind: 'folder',
        });
        this._applyEditorLink(this.localBtn, localURI, root, '');
        this._applyEditorLink(
            this.remoteBtn,
            remoteURI,
            root,
            hostname ? ` through SSH to ${hostname}` : '',
        );
    }

    _applyEditorLink(
        el: HTMLAnchorElement,
        uri: string | null,
        root: string,
        remoteSuffix: string,
    ): void {
        const baseTitle = el.id.includes('local')
            ? 'Open project in VS Code'
            : 'Open project in VS Code through SSH';
        if (!root || !uri) {
            el.setAttribute('aria-disabled', 'true');
            el.removeAttribute('href');
            el.title = root
                ? `${baseTitle} (unavailable for this path)`
                : `${baseTitle} (no active project)`;
        } else {
            el.removeAttribute('aria-disabled');
            el.setAttribute('href', uri);
            el.title = root
                ? `Open ${root} in VS Code${remoteSuffix}`
                : baseTitle;
        }
    }

    async _fetchDir(rel: string): Promise<FSListResponse> {
        const cwd = this.app.sessionsManager.activeCWD || '';
        const res = await fetch(
            `/api/fs/list?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(rel)}`,
        );
        if (!res.ok) throw new Error(await res.text());
        return await res.json();
    }

    // Renders one directory level; recurses into expanded children. An
    // expanded child that fails to list (deleted, now-ignored, or a stale
    // relpath after a cwd switch) is silently pruned from the expanded set
    // rather than failing the whole tree — deliberate: do NOT add
    // expanded-set clearing on cwd change.
    async _renderDir(
        rel: string,
        depth: number,
        requestId: number,
    ): Promise<DocumentFragment | null> {
        const data = await this._fetchDir(rel);
        if (requestId !== this.refreshRequestId) return null;
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
                    const sub = await this._renderDir(
                        childRel,
                        depth + 1,
                        requestId,
                    );
                    if (requestId !== this.refreshRequestId) return null;
                    if (sub) frag.appendChild(sub);
                } catch {
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

    _buildRow(entry: FSEntry, rel: string, depth: number): HTMLElement {
        const row = document.createElement('div');
        row.className = 'md-file-row';
        // Incremental expand/collapse walks these: rows are flat siblings
        // ordered by depth, so a folder owns every following row with a
        // greater depth until the next row at depth <= its own.
        row.dataset.rel = rel;
        row.dataset.depth = String(depth);

        const item = document.createElement('button');
        item.className = 'md-file-item';
        item.style.paddingLeft = `${8 + depth * 14}px`;
        item.title = rel;
        if (entry.dir) {
            const chev = this.expanded.has(rel) ? '▾' : '▸';
            item.innerHTML = `<span class="ft-chevron">${chev}</span><span class="md-file-name">${escapeHtml(entry.name)}</span>`;
            item.addEventListener('click', () => this._toggleDir(rel));
        } else {
            item.innerHTML = `${FILE_ICON_SVG}<span class="md-file-name">${escapeHtml(entry.name)}</span>`;
            // Left-click previews (user verdict 2026-09-16, replacing the
            // older single-click-insert review). @-mention lives in the
            // ⋯ context menu as "Insert @path".
            item.addEventListener('click', () => this._previewFile(rel));
        }

        // VS Code row actions (local + remote). Built before the
        // existing ⋯ menu so the existing fixed-width layout stays
        // intact: a row gets [item] [VSCode-local] [VSCode-remote] [⋯].
        const rowActions = this._buildVSCodeRowActions(entry, rel);

        const actionBtn = document.createElement('button');
        actionBtn.className = 'md-file-action-btn';
        actionBtn.innerHTML = '⋯';
        actionBtn.title = `Actions for ${entry.name}`;
        actionBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            this._showContextMenu(entry, rel, actionBtn);
        });

        const onContextMenu = (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            this._showContextMenu(entry, rel, actionBtn);
        };
        item.addEventListener('contextmenu', onContextMenu);
        row.addEventListener('contextmenu', onContextMenu);

        row.appendChild(item);
        if (rowActions) row.appendChild(rowActions);
        row.appendChild(actionBtn);
        return row;
    }

    /** Build the per-row local + remote VS Code anchor cluster. Returns
     *  null when vscode: launch is unsupported on this surface (the
     *  toolbar already removed itself, and we keep row geometry
     *  consistent by skipping these entirely). */
    _buildVSCodeRowActions(entry: FSEntry, rel: string): HTMLElement | null {
        if (this.vscodeUnsupported) return null;
        const cluster = document.createElement('span');
        cluster.className = 'ft-vscode-row-actions';

        const localAnchor = document.createElement('a');
        localAnchor.className = 'ft-vscode-row-btn ft-vscode-row-local-btn';
        localAnchor.innerHTML = VSCODE_LOCAL_SVG;
        localAnchor.title = 'Open in VS Code';
        localAnchor.setAttribute('aria-label', 'Open in VS Code');
        localAnchor.tabIndex = 0;
        localAnchor.addEventListener('click', (e) =>
            this._handleVSCodeRowClick(e, entry, rel, 'local'),
        );

        const remoteAnchor = document.createElement('a');
        remoteAnchor.className = 'ft-vscode-row-btn ft-vscode-row-remote-btn';
        remoteAnchor.innerHTML = VSCODE_REMOTE_SVG;
        remoteAnchor.title = 'Open in VS Code Remote';
        remoteAnchor.setAttribute('aria-label', 'Open in VS Code Remote');
        remoteAnchor.tabIndex = 0;
        remoteAnchor.addEventListener('click', (e) =>
            this._handleVSCodeRowClick(e, entry, rel, 'remote'),
        );

        cluster.appendChild(localAnchor);
        cluster.appendChild(remoteAnchor);
        // Resolve URIs synchronously now so stale-context guards
        // (next refresh may change the active CWD) kill the link
        // before the user clicks.
        this._refreshRowVSCodeURIs(cluster, entry, rel);
        return cluster;
    }

    /** Recompute the URIs on a row's VS Code anchors. Called after every
     *  row build and exposed so tests can verify the snapshot binding
     *  is honored when the active CWD changes. */
    _refreshRowVSCodeURIs(
        cluster: HTMLElement,
        entry: FSEntry,
        rel: string,
    ): void {
        const cwd = this.app.sessionsManager?.activeCWD || '';
        const localURI = buildVSCodeURI(cwd, rel);
        const hostname = normalizeHostname(this.app.hostname);
        const remoteURI = buildVSCodeRemoteURI(hostname, {
            root: cwd,
            relativePath: rel,
            kind: entry.dir ? 'folder' : 'file',
        });
        const localBtn = cluster.querySelector(
            '.ft-vscode-row-local-btn',
        ) as HTMLAnchorElement | null;
        const remoteBtn = cluster.querySelector(
            '.ft-vscode-row-remote-btn',
        ) as HTMLAnchorElement | null;
        if (localBtn) {
            this._applyEditorLink(localBtn, localURI, cwd, '');
            localBtn.title = localURI
                ? `Open ${rel} in VS Code`
                : 'Open in VS Code (unavailable for this path)';
        }
        if (remoteBtn) {
            this._applyEditorLink(remoteBtn, remoteURI, cwd, '');
            remoteBtn.title = remoteURI
                ? `Open ${rel} in VS Code through SSH to ${hostname}`
                : hostname
                  ? `Open in VS Code through SSH to ${hostname}`
                  : 'Open in VS Code Remote (no Phi hostname available)';
        }
    }

    /** Activate a row's VS Code link. We let the browser navigate via
     *  the anchor's href (synchronous, no fetch, no blank tab), but
     *  always stopPropagation first so the click does not also toggle
     *  the folder or open the file preview. Stale rows (URI is null
     *  because the active CWD changed mid-render) get their activation
     *  vetoed. */
    _handleVSCodeRowClick(
        e: MouseEvent,
        entry: FSEntry,
        rel: string,
        mode: 'local' | 'remote',
    ): void {
        e.stopPropagation();
        e.preventDefault();
        const cwd = this.app.sessionsManager?.activeCWD || '';
        const uri =
            mode === 'local'
                ? buildVSCodeURI(cwd, rel)
                : buildVSCodeRemoteURI(normalizeHostname(this.app.hostname), {
                      root: cwd,
                      relativePath: rel,
                      kind: entry.dir ? 'folder' : 'file',
                  });
        if (!uri) return;
        // Native-link dispatch: clicking an anchor with href but no
        // target opens the registered protocol handler without leaving
        // the current tab or creating a blank one.
        window.location.href = uri;
    }

    // Expand/collapse mutates the rendered tree in place. A collapse is
    // pure DOM removal — no fetch, no rebuild. An expand fetches exactly
    // the clicked directory and inserts its rows below the folder's last
    // descendant; siblings and every other expanded folder stay untouched
    // (no panel-wide flash, no loss of scroll position). Children whose
    // rels are still in the expanded set re-expand recursively.
    _toggleDir(rel: string): void {
        const row = this.treeEl.querySelector(
            `.md-file-row[data-rel="${CSS.escape(rel)}"]`,
        ) as HTMLElement | null;
        if (!row) {
            // Row not rendered (stale rel after a cwd switch): fall back
            // to the full rebuild instead of inserting orphans.
            if (this.expanded.has(rel)) this.expanded.delete(rel);
            else this.expanded.add(rel);
            void this.refresh();
            return;
        }
        const depth = Number(row.dataset.depth || '0');
        const chev = row.querySelector('.ft-chevron');
        if (this.expanded.has(rel)) {
            this.expanded.delete(rel);
            let el = row.nextElementSibling;
            while (
                el?.classList.contains('md-file-row') &&
                Number((el as HTMLElement).dataset.depth || '0') > depth
            ) {
                const next = el.nextElementSibling;
                el.remove();
                el = next;
            }
            if (chev) chev.textContent = '▸';
        } else {
            this.expanded.add(rel);
            if (chev) chev.textContent = '▾';
            void this._expandDir(rel, depth, row as HTMLElement);
        }
    }

    // Fetches one directory and inserts its rows after parentRow's subtree.
    // Captures the current refreshRequestId so a full refresh() that starts
    // mid-fetch still wins (it bumps the counter and rebuilds the tree).
    async _expandDir(
        rel: string,
        depth: number,
        parentRow: HTMLElement,
    ): Promise<void> {
        const requestId = this.refreshRequestId;
        let data: FSListResponse;
        try {
            data = await this._fetchDir(rel);
        } catch (e) {
            if (requestId !== this.refreshRequestId) return;
            this.expanded.delete(rel);
            const chev = parentRow.querySelector('.ft-chevron');
            if (chev) chev.textContent = '▸';
            this.app.showToast(`Failed to open ${rel}`, {
                type: 'error',
                title: (e as Error).message,
            });
            return;
        }
        if (requestId !== this.refreshRequestId) return;

        // Insert below the folder's last descendant (rows are ordered flat
        // by depth); directly after the folder when it has no children yet.
        let anchor: HTMLElement = parentRow;
        let el = parentRow.nextElementSibling as HTMLElement | null;
        while (
            el?.classList.contains('md-file-row') &&
            Number(el.dataset.depth || '0') > depth
        ) {
            anchor = el;
            el = el.nextElementSibling as HTMLElement | null;
        }
        const frag = document.createDocumentFragment();
        const dirRows: Array<{ rel: string; row: HTMLElement }> = [];
        for (const entry of data.entries) {
            const childRel = rel ? `${rel}/${entry.name}` : entry.name;
            const rowEl = this._buildRow(entry, childRel, depth + 1);
            frag.appendChild(rowEl);
            if (entry.dir && this.expanded.has(childRel)) {
                dirRows.push({ rel: childRel, row: rowEl });
            }
        }
        anchor.after(frag);
        // Re-expand remembered grandchildren below their freshly inserted
        // rows (same in-place path — never a panel rebuild).
        for (const { rel: childRel, row: childRow } of dirRows) {
            void this._expandDir(childRel, depth + 1, childRow);
        }
    }

    // Inserts the cwd-relative path into the chat textarea at the cursor,
    // formatted for the active tab's coder (claude → @path, bash → raw).
    // Splice semantics mirror MarkdownManager._insertRelativePath.
    _insertPath(rel: string): void {
        const coder = this.app.tabManager?.getActiveTab?.()?.coder || '';
        const insertText = formatAttachment(coder, { path: rel } as Attachment);

        const textarea = document.getElementById(
            'input-textarea',
        ) as HTMLTextAreaElement | null;
        if (!textarea) return;
        const start = textarea.selectionStart as number;
        const end = textarea.selectionEnd as number;
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

    /** Open the file in the markdown modal via MarkdownManager.previewFile.
     *  The cwd snapshot is taken at click time so a mid-modal rail switch
     *  doesn't resolve the relative path against the new server's cwd. */
    _previewFile(rel: string): void {
        const md = (
            this.app as unknown as {
                markdownManager?: {
                    previewFile: (
                        f: { path: string; name: string },
                        cwd: string,
                    ) => void;
                };
            }
        ).markdownManager;
        if (!md) return;
        const cwd = this.app.sessionsManager?.activeCWD || '';
        const name = rel.slice(
            Math.max(rel.lastIndexOf('/'), rel.lastIndexOf('\\')) + 1,
        );
        void md.previewFile({ path: rel, name }, cwd);
    }

    /** Open the file or directory in the OS file explorer on desktop hosts. */
    _openInExplorer(rel: string): void {
        const cwd = this.app.sessionsManager?.activeCWD || '';
        (window as any).__phiFileAction = { kind: 'folder', rel, cwd };
        const isDesktop =
            document.documentElement.hasAttribute('data-phi-desktop') ||
            new URLSearchParams(location.search).get('desktop') === '1' ||
            Boolean((window as any).__phiDesktop);
        if (!isDesktop) {
            this.app?.showToast?.(
                'Open in Explorer is only available in the desktop app',
                { type: 'info' },
            );
        }
    }

    _createContextMenu(): HTMLElement {
        const menu = document.createElement('div');
        menu.className = 'md-context-menu ft-context-menu hidden';
        document.body.appendChild(menu);
        return menu;
    }

    _showContextMenu(entry: FSEntry, rel: string, anchorEl: HTMLElement): void {
        if (!this.contextMenuEl) return;
        this.contextMenuEl.innerHTML = '';

        // Preview is a file-only action; directories have nothing to
        // preview, and the click-toggle-dir gesture is what they get.
        // Since left-click previews (2026-09-16), this menu is the only
        // @-mention path for files.
        const actions: Array<{
            icon: string;
            label: string;
            className: string;
            handler: () => void | Promise<void>;
        }> = [
            {
                icon: '@',
                label: 'Insert @path',
                className: 'insert-path',
                handler: () => this._insertPath(rel),
            },
        ];
        if (!entry.dir) {
            actions.push({
                icon: '◳',
                label: 'Preview',
                className: 'preview',
                handler: () => this._previewFile(rel),
            });
        }
        actions.push({
            icon: '📂',
            label: 'Open in Explorer',
            className: 'open-explorer',
            handler: () => this._openInExplorer(rel),
        });

        // VS Code actions: local first, remote second. Skipped entirely
        // on surfaces that can't dispatch vscode: (the desktop main view
        // would just hang on a denied navigation).
        if (!this.vscodeUnsupported) {
            const cwd = this.app.sessionsManager?.activeCWD || '';
            const hostname = normalizeHostname(this.app.hostname);
            const localURI = buildVSCodeURI(cwd, rel);
            if (localURI) {
                actions.push({
                    icon: VSCODE_LOCAL_SVG,
                    label: 'Open in VS Code',
                    className: 'open-vscode-local',
                    handler: () => {
                        if (localURI) window.location.href = localURI;
                    },
                });
            }
            const remoteURI = buildVSCodeRemoteURI(hostname, {
                root: cwd,
                relativePath: rel,
                kind: entry.dir ? 'folder' : 'file',
            });
            if (remoteURI) {
                actions.push({
                    icon: VSCODE_REMOTE_SVG,
                    label: 'Open in VS Code Remote',
                    className: 'open-vscode-remote',
                    handler: () => {
                        if (remoteURI) window.location.href = remoteURI;
                    },
                });
            }
        }

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
        const left = Math.max(
            8,
            Math.min(
                rect.right - menuRect.width,
                window.innerWidth - menuRect.width - 8,
            ),
        );
        const top = Math.max(
            8,
            Math.min(rect.bottom + 6, window.innerHeight - menuRect.height - 8),
        );
        this.contextMenuEl.style.left = `${left}px`;
        this.contextMenuEl.style.top = `${top}px`;
    }

    _hideContextMenu(): void {
        if (!this.contextMenuEl) return;
        this.contextMenuEl.classList.add('hidden');
    }
}
