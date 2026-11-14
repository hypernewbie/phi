/* Φ phi — Workspace manager.

   One dialog for the registered workspace list ("Projects") and the live root
   folders that group monorepo-style children ("Rest of <root>").

   Reads: /api/config through SessionsManager, plus /api/fs/browse per root.
   Writes: one serialized mutation at a time. Reads render from the backend
   cache first and refresh behind the rendered list. Writes apply locally at
   once; an HTTP error rolls back, a write that never left the browser is kept
   in a small outbox, and a write that may have arrived is never resent. */
import { mountDirectoryTree, } from './path-picker.js';
import { trapModalFocus } from './modal-focus.js';
import { formatWorkspaceLabel, serverKey } from './util.js';
const OUTBOX_KEY = 'phi_workspace_manager_outbox';
function byId(id) {
    return document.getElementById(id);
}
function isString(value) {
    return typeof value === 'string' && value !== '';
}
function mutationLabel(mutation) {
    const count = mutation.paths.length;
    switch (mutation.kind) {
        case 'add':
            return count === 1
                ? 'Adding workspace…'
                : `Adding ${count} workspaces…`;
        case 'remove':
            return count === 1
                ? 'Removing workspace…'
                : `Removing ${count} workspaces…`;
        case 'addRoot':
            return 'Adding root…';
        case 'removeRoot':
            return 'Removing root…';
    }
}
export class WorkspaceManager {
    app;
    sessions;
    overlay;
    closeBtn;
    doneBtn;
    statusEl;
    projectsList;
    projectsAll;
    projectsCount;
    removeBtn;
    rootInput;
    rootAddBtn;
    rootBrowseBtn;
    rootTreeHost;
    rootTree = null;
    rootsContainer;
    filterInput;
    trap = null;
    opener = null;
    /** Bumped on open/close and on each refresh, so late responses are dropped. */
    generation = 0;
    rootPaths = [];
    sections = new Map();
    projectSelection = new Set();
    pending = null;
    pendingState = 'idle';
    scope;
    storageKey = serverKey(OUTBOX_KEY);
    /** Bumped by every fresh (non-cached) config apply, whoever requested it. */
    configEpoch = 0;
    /** A write confirmed while the dialog was closed, shown on next open. */
    confirmNote = '';
    checking = false;
    status = '';
    statusTone = 'info';
    /** Lower-cased local filter. Never touches server state or selection. */
    filter = '';
    rowSeq = 0;
    /** Label lookups for one render pass; a root can hold hundreds of rows. */
    labelBases = [];
    labels = new Map();
    onOnline = () => {
        void this.flushPending();
    };
    constructor(app, sessions) {
        this.app = app;
        this.sessions = sessions;
        this.scope = app?.scope;
        this.overlay = byId('ws-manager-modal');
        this.closeBtn = byId('ws-manager-close');
        this.doneBtn = byId('ws-manager-done');
        this.statusEl = byId('ws-manager-status');
        this.projectsList = byId('ws-manager-projects');
        this.projectsAll = byId('ws-manager-projects-all');
        this.projectsCount = byId('ws-manager-projects-count');
        this.filterInput = byId('ws-manager-filter');
        this.removeBtn = byId('ws-manager-remove');
        this.rootInput = byId('ws-manager-root-input');
        this.rootAddBtn = byId('ws-manager-root-add');
        this.rootBrowseBtn = byId('ws-manager-root-browse');
        this.rootTreeHost = byId('ws-manager-root-tree');
        this.rootsContainer = byId('ws-manager-roots');
        this.closeBtn?.addEventListener('click', () => this.close());
        this.doneBtn?.addEventListener('click', () => this.close());
        this.removeBtn?.addEventListener('click', () => void this.removeSelected());
        this.projectsAll?.addEventListener('change', () => {
            for (const row of this.visibleProjects()) {
                if (this.projectsAll?.checked)
                    this.projectSelection.add(row);
                else
                    this.projectSelection.delete(row);
            }
            this.applyProjectControls();
        });
        this.rootAddBtn?.addEventListener('click', () => void this.addRoot());
        this.rootBrowseBtn?.addEventListener('click', () => this.toggleRootTree());
        this.filterInput?.addEventListener('input', () => {
            this.filter = this.filterInput?.value.trim().toLowerCase() ?? '';
            this.render();
        });
        this.rootInput?.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter')
                return;
            event.preventDefault();
            void this.addRoot();
        });
        if (typeof window !== 'undefined') {
            window.addEventListener('online', this.onOnline);
        }
    }
    isOpen() {
        return !!this.overlay && !this.overlay.classList.contains('hidden');
    }
    /** Opens the dialog from local state, then refreshes behind it. */
    open() {
        if (!this.overlay || this.isOpen())
            return;
        this.generation++;
        this.opener =
            document.activeElement instanceof HTMLElement &&
                document.activeElement !== document.body
                ? document.activeElement
                : null;
        this.status = this.confirmNote;
        this.confirmNote = '';
        this.statusTone = 'info';
        this.rowSeq = 0;
        this.filter = '';
        if (this.filterInput)
            this.filterInput.value = '';
        this.projectSelection.clear();
        this.restoreOutbox();
        this.syncFromConfig();
        this.overlay.classList.remove('hidden');
        this.render();
        this.trap = trapModalFocus(this.overlay, {
            onEscape: () => this.close(),
            isOpen: () => this.isOpen(),
            initialFocus: () => this.dialog(),
        });
        this.dialog().focus?.({ preventScroll: true });
        void this.refresh();
        // A write queued in an earlier visit was only waiting for a working
        // connection. Nothing else retries it, so opening the dialog does.
        if (this.pendingState === 'unsent' && this.isOnline()) {
            void this.flushPending();
        }
    }
    /** The dialog element itself: focusable, so focus can rest inside it. */
    dialog() {
        return (this.overlay?.querySelector('.modal-content') ??
            this.overlay ??
            document.body);
    }
    close() {
        if (!this.overlay || !this.isOpen())
            return;
        // A started write keeps running: closing is a view action, never a
        // cancel, so an in-flight config change is not silently dropped.
        this.generation++;
        this.closeRootTree();
        this.trap?.dispose();
        this.trap = null;
        this.overlay.classList.add('hidden');
        const opener = this.opener;
        this.opener = null;
        if (opener?.isConnected)
            opener.focus({ preventScroll: true });
    }
    /** The same manager survives an in-page backend switch. Old writes stay
     *  in their own outbox, and old responses may not touch the new backend. */
    resetForBackend() {
        this.close();
        this.closeRootTree();
        this.generation++;
        this.scope = this.app?.scope;
        this.storageKey = serverKey(OUTBOX_KEY);
        this.pending = null;
        this.pendingState = 'idle';
        this.checking = false;
        this.confirmNote = '';
        this.rootPaths = [];
        this.sections.clear();
        this.projectSelection.clear();
        this.status = '';
        if (this.rootInput)
            this.rootInput.value = '';
    }
    dispose() {
        this.close();
        this.closeRootTree();
        window.removeEventListener('online', this.onOnline);
    }
    /** Applies the local intent over every config read, not just dialog
     *  refreshes. `stale` marks a cached replay: it may paint, but it must not
     *  settle a write that only a live read can confirm. */
    onConfigApplied({ stale = false } = {}) {
        if (this.scope !== this.app?.scope ||
            this.storageKey !== serverKey(OUTBOX_KEY)) {
            this.resetForBackend();
        }
        this.restoreOutbox();
        this.syncFromConfig();
        if (!stale)
            this.configEpoch++;
        if (this.isOpen())
            this.render();
        if (this.pendingState === 'unsent' && this.isOnline()) {
            void this.flushPending();
        }
        else if (!stale && this.pendingState === 'unconfirmed') {
            this.reconcileUnconfirmed();
        }
    }
    isCurrent(scope = this.scope) {
        return (this.scope === scope && this.app?.scope === scope && !scope?.aborted);
    }
    /** Root caches paint independently of the config request. */
    async refresh() {
        const generation = ++this.generation;
        const scope = this.scope;
        this.syncFromConfig();
        const listed = this.rootPaths.slice();
        const roots = this.loadRoots(generation);
        const ok = await this.sessions.loadConfig({ refreshPanels: false });
        if (generation !== this.generation || !this.isCurrent(scope))
            return;
        if (ok)
            this.syncFromConfig();
        this.render();
        await Promise.allSettled([
            roots,
            ...this.rootPaths
                .filter((path) => !listed.includes(path))
                .map((path) => this.loadRoot(path, generation)),
        ]);
    }
    syncFromConfig() {
        const config = this.sessions.config;
        // A payload without a workspaces list says nothing about the
        // registered list; projecting the local copy through
        // applyWorkspaceList would reset a transiently active workspace.
        const hasWorkspaces = Array.isArray(config?.workspaces);
        let workspaces = hasWorkspaces
            ? config.workspaces.filter(isString)
            : this.sessions.workspaces.slice();
        const raw = config?.workspace_roots;
        let roots = Array.isArray(raw)
            ? [...new Set(raw.filter(isString))]
            : [];
        const mutation = this.pending;
        if (mutation) {
            const isRoot = mutation.kind === 'addRoot' || mutation.kind === 'removeRoot';
            let paths = isRoot ? roots : workspaces;
            if (mutation.kind === 'add' || mutation.kind === 'addRoot') {
                paths = [...new Set([...paths, ...mutation.paths])];
            }
            else {
                paths = paths.filter((path) => !mutation.paths.includes(path));
            }
            if (isRoot)
                roots = paths;
            else
                workspaces = paths;
        }
        if (hasWorkspaces || mutation) {
            this.sessions.applyWorkspaceList(workspaces, mutation ? undefined : config?.active_cwd);
        }
        this.rootPaths = roots;
        for (const path of roots) {
            if (!this.sections.has(path)) {
                this.sections.set(path, {
                    path,
                    allRows: [],
                    rows: [],
                    selection: new Set(),
                    loading: false,
                    error: '',
                    truncated: false,
                });
            }
        }
        for (const path of Array.from(this.sections.keys())) {
            if (!this.rootPaths.includes(path) && !this.pending)
                this.sections.delete(path);
        }
        for (const section of this.sections.values())
            this.partition(section, !this.pending);
        if (!this.pending) {
            const registered = new Set(this.sessions.workspaces);
            for (const path of Array.from(this.projectSelection)) {
                if (!registered.has(path))
                    this.projectSelection.delete(path);
            }
        }
    }
    /** Splits a root's children into "already a project" and "still to add". */
    partition(section, pruneSelection = true) {
        section.rows = section.allRows.filter((path) => !this.sessions.isWorkspaceRegistered(path));
        if (!pruneSelection)
            return;
        for (const path of Array.from(section.selection)) {
            if (!section.rows.includes(path))
                section.selection.delete(path);
        }
    }
    async loadRoots(generation) {
        // One paint for every "Reading folder…" placeholder; each root then
        // paints as its own listing lands, so a slow root never blocks the rest.
        for (const section of this.sections.values()) {
            if (!section.rows.length)
                section.loading = true;
        }
        this.render();
        await Promise.allSettled(this.rootPaths.map((path) => this.loadRoot(path, generation, false)));
    }
    async loadRoot(path, generation, paint = true) {
        const section = this.sections.get(path);
        if (!section)
            return;
        if (!section.rows.length)
            section.loading = true;
        if (paint)
            this.render();
        const url = `/api/fs/browse?path=${encodeURIComponent(path)}`;
        const scope = this.scope;
        const store = this.app?.getActiveStore?.();
        const cacheKey = serverKey(`phi_workspace_manager_browse:${path}`);
        const current = () => generation === this.generation &&
            this.isCurrent(scope) &&
            this.sections.get(path) === section;
        const render = (data) => {
            if (!current())
                return;
            this.applyBrowse(section, data);
            section.loading = false;
            this.render();
        };
        try {
            const cached = localStorage.getItem(cacheKey);
            if (cached)
                render(JSON.parse(cached));
        }
        catch {
            /* cached data is optional */
        }
        try {
            let data;
            if (store && typeof store.load === 'function') {
                data = (await store.load(url, scope, render));
            }
            else {
                const fetchFn = typeof scope?.fetch === 'function'
                    ? (input) => scope.fetch(input)
                    : (input) => fetch(input);
                const res = await fetchFn(url);
                if (!res.ok) {
                    throw Object.assign(new Error(`HTTP ${res.status}`), {
                        status: res.status,
                    });
                }
                data = (await res.json());
            }
            if (!current() || !data)
                return;
            this.applyBrowse(section, data);
            section.loading = false;
            section.error = '';
            try {
                localStorage.setItem(cacheKey, JSON.stringify(data));
            }
            catch {
                /* memory still applies */
            }
        }
        catch (error) {
            if (!current())
                return;
            section.loading = false;
            section.error =
                error?.status === 404
                    ? 'This folder is not readable.'
                    : 'Could not read this folder.';
        }
        this.render();
    }
    applyBrowse(section, data) {
        const allRows = [];
        for (const entry of Array.isArray(data.entries) ? data.entries : []) {
            const path = isString(entry?.path) ? entry.path : '';
            if (path)
                allRows.push(path);
        }
        section.allRows = allRows;
        section.truncated = data.truncated === true;
        this.partition(section, !this.pending);
    }
    render() {
        // Workspace membership decides both row partition and label collisions,
        // so the label cache is rebuilt once per pass, not once per row.
        this.labelBases = Array.from(new Set([...this.sessions.workspaces, ...this.rootPaths]));
        this.labels.clear();
        if (this.rootAddBtn)
            this.rootAddBtn.disabled = this.isPending();
        this.renderStatus();
        this.renderProjects();
        this.renderRoots();
        // A re-render replaces the buttons the user may have activated, which
        // drops focus to <body>. Put it back inside the dialog.
        if (this.isOpen() && document.activeElement === document.body) {
            this.dialog().focus({ preventScroll: true });
        }
    }
    renderStatus() {
        if (!this.statusEl)
            return;
        const busy = this.pendingState === 'sending';
        this.statusEl.replaceChildren();
        const text = document.createElement('span');
        text.textContent =
            this.status ||
                (busy && this.pending ? mutationLabel(this.pending) : '');
        this.statusEl.appendChild(text);
        if (this.pendingState === 'unconfirmed') {
            const check = document.createElement('button');
            check.type = 'button';
            check.className = 'ws-manager-link ws-manager-check-btn';
            check.disabled = this.checking;
            check.textContent = 'Check status';
            check.addEventListener('click', () => void this.checkStatus());
            this.statusEl.appendChild(check);
            if (!text.textContent) {
                text.textContent =
                    'Change not confirmed. It may or may not have been saved.';
            }
        }
        this.statusEl.dataset.state = this.pendingState;
        this.statusEl.dataset.tone = this.statusTone;
        // No reserved band: an empty status row would read as a gap under the
        // title, and nothing here needs the space until there is a message.
        this.statusEl.classList.toggle('hidden', !text.textContent);
    }
    renderProjects() {
        if (!this.projectsList)
            return;
        const workspaces = this.sessions.workspaces;
        const visible = this.visibleProjects();
        this.projectsList.replaceChildren();
        // The count follows the rows on screen, like the root sections below.
        if (this.projectsCount) {
            this.projectsCount.textContent = `(${visible.length})`;
        }
        if (!this.pending) {
            for (const path of Array.from(this.projectSelection)) {
                if (!workspaces.includes(path))
                    this.projectSelection.delete(path);
            }
        }
        if (workspaces.length === 0) {
            this.projectsList.appendChild(this.emptyNote('No workspaces yet.'));
        }
        else if (visible.length === 0) {
            this.projectsList.appendChild(this.emptyNote('No projects match the filter.'));
        }
        for (const path of visible) {
            this.projectsList.appendChild(this.renderRow({
                path,
                label: this.label(path),
                checked: this.projectSelection.has(path),
                onToggle: (checked) => {
                    if (checked)
                        this.projectSelection.add(path);
                    else
                        this.projectSelection.delete(path);
                    this.applyProjectControls();
                },
            }));
        }
        this.applyProjectControls();
    }
    /**
     * Updates the project controls in place. A checkbox activation must not
     * rebuild the list it lives in: the browser is still handling that click.
     * Counts describe the paths a click would send, so they follow the filter.
     */
    applyProjectControls() {
        const visible = this.visibleProjects();
        const selected = visible.filter((path) => this.projectSelection.has(path));
        if (this.projectsList) {
            for (const box of this.projectsList.querySelectorAll('.ws-manager-check')) {
                box.checked = this.projectSelection.has(box.value);
            }
        }
        if (this.projectsAll) {
            this.projectsAll.checked =
                visible.length > 0 && selected.length === visible.length;
            this.projectsAll.indeterminate =
                selected.length > 0 && selected.length < visible.length;
            this.projectsAll.disabled = visible.length === 0;
            const text = this.projectsAll.parentElement?.querySelector('span');
            if (text)
                text.textContent = this.filter ? 'Select visible' : 'All';
        }
        if (this.removeBtn) {
            this.removeBtn.textContent =
                selected.length === 1
                    ? 'Remove selected (1)'
                    : `Remove selected (${selected.length})`;
            this.removeBtn.disabled = selected.length === 0 || this.isPending();
        }
    }
    renderRoots() {
        if (!this.rootsContainer)
            return;
        this.rootsContainer.replaceChildren();
        if (this.rootPaths.length === 0) {
            this.rootsContainer.appendChild(this.emptyNote('No roots yet. Add a folder to group the projects inside it.'));
            return;
        }
        const labels = this.rootPaths.map((path) => this.label(path));
        this.rootPaths.forEach((path, index) => {
            const section = this.sections.get(path);
            if (!section)
                return;
            const element = document.createElement('section');
            element.className = 'ws-manager-section';
            const title = document.createElement('h4');
            title.className = 'ws-manager-section-title';
            const heading = document.createTextNode('Rest of ');
            const name = document.createElement('span');
            name.className = 'ws-manager-root-name';
            name.textContent = labels[index] || path;
            title.append(heading, name);
            const count = document.createElement('span');
            count.className = 'ws-manager-count';
            const visible = this.visibleRows(section);
            count.textContent = `(${visible.length})`;
            title.appendChild(count);
            const head = document.createElement('div');
            head.className = 'ws-manager-group-head';
            head.appendChild(title);
            const allLabel = document.createElement('label');
            allLabel.className = 'ws-manager-all';
            const allBox = document.createElement('input');
            allBox.type = 'checkbox';
            // Chrome warns about form fields without an id or name; the label
            // already supplies the accessible name.
            allBox.name = 'ws-manager-root-all';
            const allText = document.createElement('span');
            allText.textContent = 'All';
            allLabel.append(allBox, allText);
            allBox.addEventListener('change', () => {
                for (const row of this.visibleRows(section)) {
                    if (allBox.checked)
                        section.selection.add(row);
                    else
                        section.selection.delete(row);
                }
                this.applySectionControls(section, element);
            });
            head.appendChild(allLabel);
            element.appendChild(head);
            const rootPath = document.createElement('div');
            rootPath.className = 'ws-manager-root-path';
            rootPath.textContent = path;
            element.appendChild(rootPath);
            // The failure sits above the rows: the rows can be a cached
            // listing, and the reader must see that they may be out of date
            // without scrolling to the bottom of the section.
            if (section.error) {
                const note = document.createElement('p');
                note.className = 'ws-manager-note';
                note.textContent = section.error;
                const retry = document.createElement('button');
                retry.type = 'button';
                retry.className = 'ws-manager-link ws-manager-retry-btn';
                retry.textContent = 'Retry';
                retry.addEventListener('click', () => void this.loadRoot(path, this.generation));
                note.appendChild(retry);
                element.appendChild(note);
            }
            const list = document.createElement('div');
            list.className = 'ws-manager-list';
            if (section.rows.length === 0 && !section.error) {
                list.appendChild(this.emptyNote(section.loading
                    ? 'Reading folder…'
                    : 'Every project in this folder is already added.'));
            }
            else if (visible.length === 0 && !section.error) {
                list.appendChild(this.emptyNote('No folders here match the filter.'));
            }
            for (const child of visible) {
                list.appendChild(this.renderRow({
                    path: child,
                    label: this.label(child),
                    checked: section.selection.has(child),
                    onToggle: (checked) => {
                        if (checked)
                            section.selection.add(child);
                        else
                            section.selection.delete(child);
                        this.applySectionControls(section, element);
                    },
                }));
            }
            element.appendChild(list);
            if (section.truncated) {
                const note = document.createElement('p');
                note.className = 'ws-manager-note';
                note.textContent =
                    'This folder has more entries than the browser can list. Only the first entries are shown.';
                element.appendChild(note);
            }
            const actions = document.createElement('div');
            actions.className = 'ws-manager-group-actions';
            const removeRoot = document.createElement('button');
            removeRoot.type = 'button';
            removeRoot.className =
                'ws-manager-link ws-manager-link-danger ws-manager-root-remove';
            removeRoot.textContent = 'Remove root';
            removeRoot.disabled = this.isPending();
            removeRoot.addEventListener('click', () => void this.removeRoot(path));
            actions.appendChild(removeRoot);
            const add = document.createElement('button');
            add.type = 'button';
            add.className = 'btn btn-accent ws-manager-add-btn';
            add.addEventListener('click', () => void this.addSelected(path));
            actions.appendChild(add);
            element.appendChild(actions);
            this.rootsContainer?.appendChild(element);
            this.applySectionControls(section, element);
        });
    }
    /** Same in-place rule as applyProjectControls, per root section. */
    applySectionControls(section, element) {
        const visible = this.visibleRows(section);
        const selected = visible.filter((path) => section.selection.has(path));
        for (const box of element.querySelectorAll('.ws-manager-check')) {
            box.checked = section.selection.has(box.value);
        }
        const allBox = element.querySelector('.ws-manager-all input');
        if (allBox) {
            allBox.checked =
                visible.length > 0 && selected.length === visible.length;
            allBox.indeterminate =
                selected.length > 0 && selected.length < visible.length;
            allBox.disabled = visible.length === 0;
            const text = allBox.parentElement?.querySelector('span');
            if (text)
                text.textContent = this.filter ? 'Select visible' : 'All';
        }
        const add = element.querySelector('.ws-manager-add-btn');
        if (add) {
            add.textContent =
                selected.length === 1
                    ? 'Add selected (1)'
                    : `Add selected (${selected.length})`;
            add.disabled = selected.length === 0 || this.isPending();
        }
    }
    /** Children of a root that are not registered and match the filter. */
    visibleRows(section) {
        return section.rows.filter((path) => this.matches(path));
    }
    visibleProjects() {
        return this.sessions.workspaces.filter((path) => this.matches(path));
    }
    matches(path) {
        if (!this.filter)
            return true;
        if (path.toLowerCase().includes(this.filter))
            return true;
        return this.label(path).toLowerCase().includes(this.filter);
    }
    renderRow(options) {
        const row = document.createElement('label');
        row.className = 'ws-manager-row';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.className = 'ws-manager-check';
        box.checked = options.checked;
        box.value = options.path;
        box.id = `ws-manager-row-${++this.rowSeq}`;
        box.addEventListener('change', () => options.onToggle(box.checked));
        const name = document.createElement('span');
        name.className = 'ws-manager-name';
        name.textContent = options.label;
        const path = document.createElement('span');
        path.className = 'ws-manager-path';
        path.textContent = options.path;
        // The path is truncated to keep rows one line; the full value stays
        // reachable on hover and for assistive tech.
        row.title = options.path;
        row.append(box, name, path);
        return row;
    }
    emptyNote(text) {
        const note = document.createElement('p');
        note.className = 'ws-manager-note';
        note.textContent = text;
        return note;
    }
    label(path) {
        const cached = this.labels.get(path);
        if (cached !== undefined)
            return cached;
        const label = formatWorkspaceLabel(path, this.labelBases);
        this.labels.set(path, label);
        return label;
    }
    /**
     * One write at a time. A write that never left the browser still owns the
     * outbox, so a second mutation would silently replace it; inputs stay
     * locked until that write is sent or reconciled.
     */
    isPending() {
        return this.pendingState !== 'idle';
    }
    isOnline() {
        return typeof navigator === 'undefined' || navigator.onLine !== false;
    }
    /** `tone` only colours the line: an error must not look like a hint. */
    setStatus(text, tone = 'info') {
        this.status = text;
        this.statusTone = tone;
        this.render();
    }
    async removeSelected() {
        const paths = this.visibleProjects().filter((path) => this.projectSelection.has(path));
        if (paths.length === 0)
            return;
        await this.mutate({ kind: 'remove', paths });
    }
    async addSelected(rootPath) {
        const section = this.sections.get(rootPath);
        if (!section)
            return;
        const paths = this.visibleRows(section).filter((path) => section.selection.has(path));
        if (paths.length === 0)
            return;
        await this.mutate({ kind: 'add', paths });
    }
    async addRoot() {
        const raw = this.rootInput?.value.trim() ?? '';
        if (!raw) {
            this.setStatus('Enter a folder path to add a root.');
            this.rootInput?.focus({ preventScroll: true });
            return;
        }
        await this.mutate({ kind: 'addRoot', paths: [raw] });
    }
    async removeRoot(path) {
        await this.mutate({ kind: 'removeRoot', paths: [path] });
    }
    /**
     * The same directory tree the Add Workspace dialog uses. Picking a folder
     * fills the path field; adding stays an explicit click, so browsing never
     * registers anything by itself.
     */
    toggleRootTree() {
        if (!this.rootTreeHost)
            return;
        if (this.rootTree && !this.rootTreeHost.classList.contains('hidden')) {
            this.closeRootTree();
            return;
        }
        const start = this.rootInput?.value.trim() ||
            this.sessions.activeWorkspace ||
            '~';
        this.rootTreeHost.classList.remove('hidden');
        if (this.rootBrowseBtn) {
            this.rootBrowseBtn.setAttribute('aria-expanded', 'true');
            this.rootBrowseBtn.textContent = 'Hide';
        }
        this.rootTree = mountDirectoryTree(this.rootTreeHost, {
            startPath: start,
            onSelect: (path) => {
                if (this.rootInput)
                    this.rootInput.value = path;
                this.closeRootTree();
                this.rootInput?.focus({ preventScroll: true });
            },
        });
        if (this.rootInput?.value.trim()) {
            void this.rootTree.reveal(start);
        }
    }
    closeRootTree() {
        this.rootTree?.destroy();
        this.rootTree = null;
        this.rootTreeHost?.classList.add('hidden');
        if (this.rootBrowseBtn) {
            this.rootBrowseBtn.setAttribute('aria-expanded', 'false');
            this.rootBrowseBtn.textContent = 'Browse';
        }
    }
    /** Queue before sending; config reads always project this intent locally. */
    async mutate(mutation) {
        if (this.isPending() || !this.isCurrent())
            return;
        this.pending = mutation;
        this.pendingState = 'unsent';
        this.writeOutbox(mutation, 'unsent');
        this.syncFromConfig();
        this.setStatus('Saved in this browser. It is sent when the server is reachable.');
        await this.flushPending();
    }
    async send(mutation) {
        const isRoot = mutation.kind === 'addRoot' || mutation.kind === 'removeRoot';
        const method = mutation.kind === 'add' || mutation.kind === 'addRoot'
            ? 'POST'
            : 'DELETE';
        const body = isRoot
            ? JSON.stringify({ path: mutation.paths[0] })
            : JSON.stringify({ paths: mutation.paths });
        const url = isRoot
            ? '/api/config/workspace-roots'
            : '/api/config/workspaces';
        const scope = this.app?.scope;
        const fetchFn = typeof scope?.fetch === 'function'
            ? (input, init) => scope.fetch(input, init)
            : (input, init) => fetch(input, init);
        return fetchFn(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body,
        });
    }
    /** A read can reconcile a write, but must never trigger another send. */
    async checkStatus(confirmed = false) {
        if (this.checking || !this.pending || !this.isCurrent())
            return;
        const mutation = this.pending;
        const scope = this.scope;
        const epoch = this.configEpoch;
        this.checking = true;
        this.setStatus('Checking the server…');
        const ok = await this.sessions.loadConfig({ refreshPanels: false });
        if (!this.isCurrent(scope) || this.pending !== mutation) {
            // A newer read already settled this write (its own message stands).
            this.checking = false;
            return;
        }
        this.checking = false;
        // A read that lost the request race reports false. If any fresh config
        // arrived meanwhile, the write is settled just as well.
        if (!ok && this.configEpoch === epoch) {
            this.pendingState = 'unconfirmed';
            this.setStatus(confirmed
                ? 'Saved on the server. The reload failed; check status when connected.'
                : 'Change not confirmed. Nothing was resent. Check status when connected.', 'error');
            return;
        }
        this.pending = null;
        this.pendingState = 'idle';
        this.writeOutbox(null);
        this.syncFromConfig();
        if (confirmed)
            this.setStatus('Saved.');
        else
            this.setReconcileStatus(mutation);
        if (this.isOpen())
            void this.loadRoots(this.generation);
    }
    /** Compares one write with one config snapshot. Workspaces compare by
     *  normalized path; roots are stored expanded, so they compare exactly. */
    landedIn(mutation, workspaces, roots) {
        const registered = (path) => this.sessions.isWorkspaceIn(workspaces, path);
        switch (mutation.kind) {
            case 'add':
                return mutation.paths.every(registered);
            case 'remove':
                return mutation.paths.every((path) => !registered(path));
            case 'addRoot': {
                const path = mutation.paths[0] ?? '';
                if (roots.includes(path))
                    return true;
                // A typed "~/code" was stored expanded, so it cannot be matched.
                return path.startsWith('~') ? null : false;
            }
            case 'removeRoot':
                return mutation.paths.every((path) => !roots.includes(path));
        }
    }
    /**
     * A fresh read is the only thing that may settle an unconfirmed write,
     * because the request itself must never be sent twice. It compares the
     * server's own lists, not the projected view, which always reflects the
     * pending intent.
     */
    reconcileUnconfirmed() {
        const mutation = this.pending;
        if (!mutation)
            return;
        const config = this.sessions.config;
        const workspaces = Array.isArray(config?.workspaces)
            ? config.workspaces.filter(isString)
            : [];
        const roots = Array.isArray(config?.workspace_roots)
            ? config.workspace_roots.filter(isString)
            : [];
        const landed = this.landedIn(mutation, workspaces, roots);
        // Only a positive read may clear the warning. A negative one can be a
        // read that raced a write still being committed, so the ambiguous state
        // stays visible and the explicit Check status remains the way out.
        if (landed !== true)
            return;
        this.pending = null;
        this.pendingState = 'idle';
        this.writeOutbox(null);
        this.syncFromConfig();
        // The dialog may be closed when the confirming read arrives (on load,
        // for example); keep the outcome for the next open instead of losing it.
        if (this.isOpen()) {
            this.setStatus('Saved.');
            void this.loadRoots(this.generation);
        }
        else {
            this.confirmNote = 'Saved.';
        }
    }
    setReconcileStatus(mutation) {
        // The pending write is cleared before this runs, so the live lists are
        // the server's own. `null` means the stored list cannot answer it, so
        // the message must not claim an outcome.
        const landed = mutation
            ? this.landedIn(mutation, this.sessions.workspaces, this.rootPaths)
            : null;
        if (landed === false) {
            this.setStatus('This change is not in the current server state. Nothing was resent.', 'error');
            return;
        }
        this.setStatus(landed === true
            ? 'Saved.'
            : 'Server state reloaded. Nothing was resent.');
    }
    /** Only never-started work may be sent. Persist ambiguity BEFORE fetch. */
    async flushPending() {
        const mutation = this.pending;
        const scope = this.scope;
        if (!mutation ||
            this.pendingState !== 'unsent' ||
            !this.isOnline() ||
            !this.isCurrent(scope))
            return;
        this.pendingState = 'sending';
        this.writeOutbox(mutation, 'unconfirmed');
        this.status = '';
        this.statusTone = 'info';
        this.render();
        let response;
        try {
            response = await this.send(mutation);
        }
        catch {
            if (!this.isCurrent(scope) || this.pending !== mutation)
                return;
            // A rejection cannot prove the request never arrived: the response
            // can be lost after the server accepted the write, even with the
            // browser already reporting offline. Never resend it; a read
            // settles it instead.
            this.pendingState = 'unconfirmed';
            this.setStatus('Change not confirmed. It may or may not have been saved.', 'error');
            await this.checkStatus();
            return;
        }
        if (!this.isCurrent(scope) || this.pending !== mutation)
            return;
        if (!response.ok) {
            const message = await response.text().catch(() => '');
            if (!this.isCurrent(scope) || this.pending !== mutation)
                return;
            this.pending = null;
            this.pendingState = 'idle';
            this.writeOutbox(null);
            this.syncFromConfig();
            this.setStatus(message.trim() || 'The server rejected the change.', 'error');
            return;
        }
        if (mutation.kind === 'addRoot' &&
            this.rootInput?.value.trim() === mutation.paths[0]) {
            this.rootInput.value = '';
        }
        await this.checkStatus(true);
    }
    restoreOutbox() {
        if (this.pending)
            return;
        const stored = this.readOutbox();
        if (!stored)
            return;
        this.pending = stored.mutation;
        this.pendingState = stored.state;
        this.status =
            stored.state === 'unsent'
                ? 'Saved in this browser. It is sent when the server is reachable.'
                : 'Change not confirmed. It may or may not have been saved.';
        this.statusTone = stored.state === 'unsent' ? 'info' : 'error';
    }
    readOutbox() {
        if (typeof localStorage === 'undefined')
            return null;
        try {
            const raw = localStorage.getItem(this.outboxKey());
            if (!raw)
                return null;
            const parsed = JSON.parse(raw);
            const kinds = [
                'add',
                'remove',
                'addRoot',
                'removeRoot',
            ];
            if (!kinds.includes(parsed?.kind))
                return null;
            const paths = Array.isArray(parsed.paths)
                ? parsed.paths.filter(isString)
                : [];
            if (paths.length === 0)
                return null;
            const state = parsed.state === 'unsent' ? 'unsent' : 'unconfirmed';
            return { mutation: { kind: parsed.kind, paths }, state };
        }
        catch {
            return null;
        }
    }
    writeOutbox(mutation, state = 'unsent') {
        if (typeof localStorage === 'undefined')
            return;
        try {
            if (mutation) {
                localStorage.setItem(this.outboxKey(), JSON.stringify({ ...mutation, state }));
            }
            else {
                localStorage.removeItem(this.outboxKey());
            }
        }
        catch {
            /* storage unavailable: the in-memory state still applies */
        }
    }
    outboxKey() {
        return this.storageKey;
    }
}
