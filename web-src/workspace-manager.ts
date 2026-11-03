/* Φ phi — Workspace manager.

   One dialog for the registered workspace list ("Projects") and the live root
   folders that group monorepo-style children ("Rest of <root>").

   Reads: /api/config through SessionsManager, plus /api/fs/browse per root.
   Writes: one serialized mutation at a time. Reads render from the backend
   cache first and refresh behind the rendered list. Writes apply locally at
   once; an HTTP error rolls back, a write that never left the browser is kept
   in a small outbox, and a write that may have arrived is never resent. */

import type { SessionsManager } from './sessions.js';
import type { AppLike } from './types.js';
import type { BackendScope } from './backend-scope.js';
import {
    mountDirectoryTree,
    type DirectoryTreeController,
} from './path-picker.js';
import { trapModalFocus, type ModalFocusTrap } from './modal-focus.js';
import { formatWorkspaceLabel, serverKey } from './util.js';

interface BrowseEntry {
    name?: unknown;
    path?: unknown;
}

interface BrowseResponse {
    entries?: BrowseEntry[];
    truncated?: boolean;
}

type MutationKind = 'add' | 'remove' | 'addRoot' | 'removeRoot';

/** One pending config write. `paths` is a batch for workspaces, one path for roots. */
interface Mutation {
    kind: MutationKind;
    paths: string[];
}

interface RootSection {
    path: string;
    /** Every child directory the folder currently has. */
    allRows: string[];
    /** Visible rows: children that are not registered workspaces. */
    rows: string[];
    selection: Set<string>;
    loading: boolean;
    error: string;
    truncated: boolean;
}

/** idle | sending (in flight) | unsent (never left the browser) | unconfirmed (may have arrived). */
type PendingState = 'idle' | 'sending' | 'unsent' | 'unconfirmed';

const OUTBOX_KEY = 'phi_workspace_manager_outbox';

function byId<T extends HTMLElement>(id: string): T | null {
    return document.getElementById(id) as T | null;
}

function isString(value: unknown): value is string {
    return typeof value === 'string' && value !== '';
}

function mutationLabel(mutation: Mutation): string {
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
    private readonly app: AppLike;
    private readonly sessions: SessionsManager;

    private readonly overlay: HTMLElement | null;
    private readonly closeBtn: HTMLElement | null;
    private readonly doneBtn: HTMLElement | null;
    private readonly statusEl: HTMLElement | null;
    private readonly projectsList: HTMLElement | null;
    private readonly projectsAll: HTMLInputElement | null;
    private readonly projectsCount: HTMLElement | null;
    private readonly removeBtn: HTMLButtonElement | null;
    private readonly rootInput: HTMLInputElement | null;
    private readonly rootAddBtn: HTMLButtonElement | null;
    private readonly rootBrowseBtn: HTMLButtonElement | null;
    private readonly rootTreeHost: HTMLElement | null;
    private rootTree: DirectoryTreeController | null = null;
    private readonly rootsContainer: HTMLElement | null;
    private readonly filterInput: HTMLInputElement | null;

    private trap: ModalFocusTrap | null = null;
    private opener: HTMLElement | null = null;
    /** Bumped on open/close and on each refresh, so late responses are dropped. */
    private generation = 0;
    private rootPaths: string[] = [];
    private sections = new Map<string, RootSection>();
    private projectSelection = new Set<string>();
    private pending: Mutation | null = null;
    private pendingState: PendingState = 'idle';
    private scope: BackendScope | null | undefined;
    private storageKey = serverKey(OUTBOX_KEY);
    private checking = false;
    private status = '';
    private statusTone: 'info' | 'error' = 'info';
    /** Lower-cased local filter. Never touches server state or selection. */
    private filter = '';
    private rowSeq = 0;
    /** Label lookups for one render pass; a root can hold hundreds of rows. */
    private labelBases: string[] = [];
    private labels = new Map<string, string>();
    private readonly onOnline = (): void => {
        void this.flushPending();
    };

    constructor(app: AppLike, sessions: SessionsManager) {
        this.app = app;
        this.sessions = sessions;
        this.scope = app?.scope;
        this.overlay = byId('ws-manager-modal');
        this.closeBtn = byId('ws-manager-close');
        this.doneBtn = byId('ws-manager-done');
        this.statusEl = byId('ws-manager-status');
        this.projectsList = byId('ws-manager-projects');
        this.projectsAll = byId<HTMLInputElement>('ws-manager-projects-all');
        this.projectsCount = byId('ws-manager-projects-count');
        this.filterInput = byId<HTMLInputElement>('ws-manager-filter');
        this.removeBtn = byId<HTMLButtonElement>('ws-manager-remove');
        this.rootInput = byId<HTMLInputElement>('ws-manager-root-input');
        this.rootAddBtn = byId<HTMLButtonElement>('ws-manager-root-add');
        this.rootBrowseBtn = byId<HTMLButtonElement>('ws-manager-root-browse');
        this.rootTreeHost = byId('ws-manager-root-tree');
        this.rootsContainer = byId('ws-manager-roots');

        this.closeBtn?.addEventListener('click', () => this.close());
        this.doneBtn?.addEventListener('click', () => this.close());
        this.removeBtn?.addEventListener(
            'click',
            () => void this.removeSelected(),
        );
        this.projectsAll?.addEventListener('change', () => {
            for (const row of this.visibleProjects()) {
                if (this.projectsAll?.checked) this.projectSelection.add(row);
                else this.projectSelection.delete(row);
            }
            this.applyProjectControls();
        });
        this.rootAddBtn?.addEventListener('click', () => void this.addRoot());
        this.rootBrowseBtn?.addEventListener('click', () =>
            this.toggleRootTree(),
        );
        this.filterInput?.addEventListener('input', () => {
            this.filter = this.filterInput?.value.trim().toLowerCase() ?? '';
            this.render();
        });
        this.rootInput?.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            void this.addRoot();
        });
        if (typeof window !== 'undefined') {
            window.addEventListener('online', this.onOnline);
        }
    }

    isOpen(): boolean {
        return !!this.overlay && !this.overlay.classList.contains('hidden');
    }

    /** Opens the dialog from local state, then refreshes behind it. */
    open(): void {
        if (!this.overlay || this.isOpen()) return;
        this.generation++;
        this.opener =
            document.activeElement instanceof HTMLElement &&
            document.activeElement !== document.body
                ? document.activeElement
                : null;
        this.status = '';
        this.statusTone = 'info';
        this.rowSeq = 0;
        this.filter = '';
        if (this.filterInput) this.filterInput.value = '';
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
    private dialog(): HTMLElement {
        return (
            this.overlay?.querySelector<HTMLElement>('.modal-content') ??
            this.overlay ??
            document.body
        );
    }

    close(): void {
        if (!this.overlay || !this.isOpen()) return;
        // A started write keeps running: closing is a view action, never a
        // cancel, so an in-flight config change is not silently dropped.
        this.generation++;
        this.closeRootTree();
        this.trap?.dispose();
        this.trap = null;
        this.overlay.classList.add('hidden');
        const opener = this.opener;
        this.opener = null;
        if (opener?.isConnected) opener.focus({ preventScroll: true });
    }

    /** The same manager survives an in-page backend switch. Old writes stay
     *  in their own outbox, and old responses may not touch the new backend. */
    resetForBackend(): void {
        this.close();
        this.closeRootTree();
        this.generation++;
        this.scope = this.app?.scope;
        this.storageKey = serverKey(OUTBOX_KEY);
        this.pending = null;
        this.pendingState = 'idle';
        this.checking = false;
        this.rootPaths = [];
        this.sections.clear();
        this.projectSelection.clear();
        this.status = '';
        if (this.rootInput) this.rootInput.value = '';
    }

    dispose(): void {
        this.close();
        this.closeRootTree();
        window.removeEventListener('online', this.onOnline);
    }

    /** Apply the local intent over every config read, not just dialog refreshes. */
    onConfigApplied(): void {
        if (
            this.scope !== this.app?.scope ||
            this.storageKey !== serverKey(OUTBOX_KEY)
        ) {
            this.resetForBackend();
        }
        this.restoreOutbox();
        this.syncFromConfig();
        if (this.isOpen()) this.render();
        if (this.pendingState === 'unsent' && this.isOnline())
            void this.flushPending();
    }

    private isCurrent(scope = this.scope): boolean {
        return (
            this.scope === scope && this.app?.scope === scope && !scope?.aborted
        );
    }

    /** Root caches paint independently of the config request. */
    async refresh(): Promise<void> {
        const generation = ++this.generation;
        const scope = this.scope;
        this.syncFromConfig();
        const listed = this.rootPaths.slice();
        const roots = this.loadRoots(generation);
        const ok = await this.sessions.loadConfig({ refreshPanels: false });
        if (generation !== this.generation || !this.isCurrent(scope)) return;
        if (ok) this.syncFromConfig();
        this.render();
        await Promise.allSettled([
            roots,
            ...this.rootPaths
                .filter((path) => !listed.includes(path))
                .map((path) => this.loadRoot(path, generation)),
        ]);
    }

    private syncFromConfig(): void {
        const config = this.sessions.config as any;
        let workspaces = Array.isArray(config?.workspaces)
            ? config.workspaces.filter(isString)
            : this.sessions.workspaces.slice();
        const raw = config?.workspace_roots;
        let roots: string[] = Array.isArray(raw)
            ? [...new Set(raw.filter(isString))]
            : [];
        const mutation = this.pending;
        if (mutation) {
            const isRoot =
                mutation.kind === 'addRoot' || mutation.kind === 'removeRoot';
            let paths = isRoot ? roots : workspaces;
            if (mutation.kind === 'add' || mutation.kind === 'addRoot') {
                paths = [...new Set([...paths, ...mutation.paths])];
            } else {
                paths = paths.filter(
                    (path: string) => !mutation.paths.includes(path),
                );
            }
            if (isRoot) roots = paths;
            else workspaces = paths;
        }
        this.sessions.applyWorkspaceList(
            workspaces,
            mutation ? undefined : config?.active_cwd,
        );
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
                if (!registered.has(path)) this.projectSelection.delete(path);
            }
        }
    }

    /** Splits a root's children into "already a project" and "still to add". */
    private partition(section: RootSection, pruneSelection = true): void {
        section.rows = section.allRows.filter(
            (path) => !this.sessions.isWorkspaceRegistered(path),
        );
        if (!pruneSelection) return;
        for (const path of Array.from(section.selection)) {
            if (!section.rows.includes(path)) section.selection.delete(path);
        }
    }

    private async loadRoots(generation: number): Promise<void> {
        // One paint for every "Reading folder…" placeholder; each root then
        // paints as its own listing lands, so a slow root never blocks the rest.
        for (const section of this.sections.values()) {
            if (!section.rows.length) section.loading = true;
        }
        this.render();
        await Promise.allSettled(
            this.rootPaths.map((path) =>
                this.loadRoot(path, generation, false),
            ),
        );
    }

    private async loadRoot(
        path: string,
        generation: number,
        paint = true,
    ): Promise<void> {
        const section = this.sections.get(path);
        if (!section) return;
        if (!section.rows.length) section.loading = true;
        if (paint) this.render();

        const url = `/api/fs/browse?path=${encodeURIComponent(path)}`;
        const scope = this.scope;
        const store = (this.app as any)?.getActiveStore?.();
        const cacheKey = serverKey(`phi_workspace_manager_browse:${path}`);
        const current = () =>
            generation === this.generation &&
            this.isCurrent(scope) &&
            this.sections.get(path) === section;
        const render = (data: BrowseResponse): void => {
            if (!current()) return;
            this.applyBrowse(section, data);
            section.loading = false;
            this.render();
        };
        try {
            const cached = localStorage.getItem(cacheKey);
            if (cached) render(JSON.parse(cached));
        } catch {
            /* cached data is optional */
        }

        try {
            let data: BrowseResponse | undefined;
            if (store && typeof store.load === 'function') {
                data = (await store.load(url, scope, render)) as
                    | BrowseResponse
                    | undefined;
            } else {
                const fetchFn =
                    typeof scope?.fetch === 'function'
                        ? (input: string) => scope.fetch(input)
                        : (input: string) => fetch(input);
                const res = await fetchFn(url);
                if (!res.ok) {
                    throw Object.assign(new Error(`HTTP ${res.status}`), {
                        status: res.status,
                    });
                }
                data = (await res.json()) as BrowseResponse;
            }
            if (!current() || !data) return;
            this.applyBrowse(section, data);
            section.loading = false;
            section.error = '';
            try {
                localStorage.setItem(cacheKey, JSON.stringify(data));
            } catch {
                /* memory still applies */
            }
        } catch (error: any) {
            if (!current()) return;
            section.loading = false;
            section.error =
                error?.status === 404
                    ? 'This folder is not readable.'
                    : 'Could not read this folder.';
        }
        this.render();
    }

    private applyBrowse(section: RootSection, data: BrowseResponse): void {
        const allRows: string[] = [];
        for (const entry of Array.isArray(data.entries) ? data.entries : []) {
            const path = isString(entry?.path) ? entry.path : '';
            if (path) allRows.push(path);
        }
        section.allRows = allRows;
        section.truncated = data.truncated === true;
        this.partition(section, !this.pending);
    }

    private render(): void {
        // Workspace membership decides both row partition and label collisions,
        // so the label cache is rebuilt once per pass, not once per row.
        this.labelBases = Array.from(
            new Set([...this.sessions.workspaces, ...this.rootPaths]),
        );
        this.labels.clear();
        if (this.rootAddBtn) this.rootAddBtn.disabled = this.isPending();
        this.renderStatus();
        this.renderProjects();
        this.renderRoots();
        // A re-render replaces the buttons the user may have activated, which
        // drops focus to <body>. Put it back inside the dialog.
        if (this.isOpen() && document.activeElement === document.body) {
            this.dialog().focus({ preventScroll: true });
        }
    }

    private renderStatus(): void {
        if (!this.statusEl) return;
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

    private renderProjects(): void {
        if (!this.projectsList) return;
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
        } else if (visible.length === 0) {
            this.projectsList.appendChild(
                this.emptyNote('No projects match the filter.'),
            );
        }
        for (const path of visible) {
            this.projectsList.appendChild(
                this.renderRow({
                    path,
                    label: this.label(path),
                    checked: this.projectSelection.has(path),
                    onToggle: (checked) => {
                        if (checked) this.projectSelection.add(path);
                        else this.projectSelection.delete(path);
                        this.applyProjectControls();
                    },
                }),
            );
        }
        this.applyProjectControls();
    }

    /**
     * Updates the project controls in place. A checkbox activation must not
     * rebuild the list it lives in: the browser is still handling that click.
     * Counts describe the paths a click would send, so they follow the filter.
     */
    private applyProjectControls(): void {
        const visible = this.visibleProjects();
        const selected = visible.filter((path) =>
            this.projectSelection.has(path),
        );
        if (this.projectsList) {
            for (const box of this.projectsList.querySelectorAll<HTMLInputElement>(
                '.ws-manager-check',
            )) {
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
            if (text) text.textContent = this.filter ? 'Select visible' : 'All';
        }
        if (this.removeBtn) {
            this.removeBtn.textContent =
                selected.length === 1
                    ? 'Remove selected (1)'
                    : `Remove selected (${selected.length})`;
            this.removeBtn.disabled = selected.length === 0 || this.isPending();
        }
    }

    private renderRoots(): void {
        if (!this.rootsContainer) return;
        this.rootsContainer.replaceChildren();
        if (this.rootPaths.length === 0) {
            this.rootsContainer.appendChild(
                this.emptyNote(
                    'No roots yet. Add a folder to group the projects inside it.',
                ),
            );
            return;
        }
        const labels = this.rootPaths.map((path) => this.label(path));
        this.rootPaths.forEach((path, index) => {
            const section = this.sections.get(path);
            if (!section) return;
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
                    if (allBox.checked) section.selection.add(row);
                    else section.selection.delete(row);
                }
                this.applySectionControls(section, element);
            });
            head.appendChild(allLabel);
            element.appendChild(head);

            const rootPath = document.createElement('div');
            rootPath.className = 'ws-manager-root-path';
            rootPath.textContent = path;
            element.appendChild(rootPath);

            const list = document.createElement('div');
            list.className = 'ws-manager-list';
            if (section.rows.length === 0 && !section.error) {
                list.appendChild(
                    this.emptyNote(
                        section.loading
                            ? 'Reading folder…'
                            : 'Every project in this folder is already added.',
                    ),
                );
            } else if (visible.length === 0 && !section.error) {
                list.appendChild(
                    this.emptyNote('No folders here match the filter.'),
                );
            }
            for (const child of visible) {
                list.appendChild(
                    this.renderRow({
                        path: child,
                        label: this.label(child),
                        checked: section.selection.has(child),
                        onToggle: (checked) => {
                            if (checked) section.selection.add(child);
                            else section.selection.delete(child);
                            this.applySectionControls(section, element);
                        },
                    }),
                );
            }
            element.appendChild(list);

            if (section.error) {
                const note = document.createElement('p');
                note.className = 'ws-manager-note';
                note.textContent = section.error;
                const retry = document.createElement('button');
                retry.type = 'button';
                retry.className = 'ws-manager-link ws-manager-retry-btn';
                retry.textContent = 'Retry';
                retry.addEventListener(
                    'click',
                    () => void this.loadRoot(path, this.generation),
                );
                note.appendChild(retry);
                element.appendChild(note);
            }
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
            removeRoot.className = 'btn btn-red ws-manager-root-remove';
            removeRoot.textContent = 'Remove root';
            removeRoot.disabled = this.isPending();
            removeRoot.addEventListener(
                'click',
                () => void this.removeRoot(path),
            );
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
    private applySectionControls(
        section: RootSection,
        element: HTMLElement,
    ): void {
        const visible = this.visibleRows(section);
        const selected = visible.filter((path) => section.selection.has(path));
        for (const box of element.querySelectorAll<HTMLInputElement>(
            '.ws-manager-check',
        )) {
            box.checked = section.selection.has(box.value);
        }
        const allBox = element.querySelector<HTMLInputElement>(
            '.ws-manager-all input',
        );
        if (allBox) {
            allBox.checked =
                visible.length > 0 && selected.length === visible.length;
            allBox.indeterminate =
                selected.length > 0 && selected.length < visible.length;
            allBox.disabled = visible.length === 0;
            const text = allBox.parentElement?.querySelector('span');
            if (text) text.textContent = this.filter ? 'Select visible' : 'All';
        }
        const add = element.querySelector<HTMLButtonElement>(
            '.ws-manager-add-btn',
        );
        if (add) {
            add.textContent =
                selected.length === 1
                    ? 'Add selected (1)'
                    : `Add selected (${selected.length})`;
            add.disabled = selected.length === 0 || this.isPending();
        }
    }

    /** Children of a root that are not registered and match the filter. */
    private visibleRows(section: RootSection): string[] {
        return section.rows.filter((path) => this.matches(path));
    }

    private visibleProjects(): string[] {
        return this.sessions.workspaces.filter((path) => this.matches(path));
    }

    private matches(path: string): boolean {
        if (!this.filter) return true;
        if (path.toLowerCase().includes(this.filter)) return true;
        return this.label(path).toLowerCase().includes(this.filter);
    }

    private renderRow(options: {
        path: string;
        label: string;
        checked: boolean;
        onToggle: (checked: boolean) => void;
    }): HTMLLabelElement {
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

    private emptyNote(text: string): HTMLElement {
        const note = document.createElement('p');
        note.className = 'ws-manager-note';
        note.textContent = text;
        return note;
    }

    private label(path: string): string {
        const cached = this.labels.get(path);
        if (cached !== undefined) return cached;
        const label = formatWorkspaceLabel(path, this.labelBases);
        this.labels.set(path, label);
        return label;
    }

    /**
     * One write at a time. A write that never left the browser still owns the
     * outbox, so a second mutation would silently replace it; inputs stay
     * locked until that write is sent or reconciled.
     */
    private isPending(): boolean {
        return this.pendingState !== 'idle';
    }

    private isOnline(): boolean {
        return typeof navigator === 'undefined' || navigator.onLine !== false;
    }

    /** `tone` only colours the line: an error must not look like a hint. */
    private setStatus(text: string, tone: 'info' | 'error' = 'info'): void {
        this.status = text;
        this.statusTone = tone;
        this.render();
    }

    private async removeSelected(): Promise<void> {
        const paths = this.visibleProjects().filter((path) =>
            this.projectSelection.has(path),
        );
        if (paths.length === 0) return;
        await this.mutate({ kind: 'remove', paths });
    }

    private async addSelected(rootPath: string): Promise<void> {
        const section = this.sections.get(rootPath);
        if (!section) return;
        const paths = this.visibleRows(section).filter((path) =>
            section.selection.has(path),
        );
        if (paths.length === 0) return;
        await this.mutate({ kind: 'add', paths });
    }

    private async addRoot(): Promise<void> {
        const raw = this.rootInput?.value.trim() ?? '';
        if (!raw) {
            this.setStatus('Enter a folder path to add a root.');
            this.rootInput?.focus({ preventScroll: true });
            return;
        }
        await this.mutate({ kind: 'addRoot', paths: [raw] });
    }

    private async removeRoot(path: string): Promise<void> {
        await this.mutate({ kind: 'removeRoot', paths: [path] });
    }

    /**
     * The same directory tree the Add Workspace dialog uses. Picking a folder
     * fills the path field; adding stays an explicit click, so browsing never
     * registers anything by itself.
     */
    private toggleRootTree(): void {
        if (!this.rootTreeHost) return;
        if (this.rootTree && !this.rootTreeHost.classList.contains('hidden')) {
            this.closeRootTree();
            return;
        }
        const start =
            this.rootInput?.value.trim() ||
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
                if (this.rootInput) this.rootInput.value = path;
                this.closeRootTree();
                this.rootInput?.focus({ preventScroll: true });
            },
        });
        if (this.rootInput?.value.trim()) {
            void this.rootTree.reveal(start);
        }
    }

    private closeRootTree(): void {
        this.rootTree?.destroy();
        this.rootTree = null;
        this.rootTreeHost?.classList.add('hidden');
        if (this.rootBrowseBtn) {
            this.rootBrowseBtn.setAttribute('aria-expanded', 'false');
            this.rootBrowseBtn.textContent = 'Browse';
        }
    }

    /** Queue before sending; config reads always project this intent locally. */
    private async mutate(mutation: Mutation): Promise<void> {
        if (this.isPending() || !this.isCurrent()) return;
        this.pending = mutation;
        this.pendingState = 'unsent';
        this.writeOutbox(mutation, 'unsent');
        this.syncFromConfig();
        this.setStatus(
            'Saved in this browser. It is sent when the server is reachable.',
        );
        await this.flushPending();
    }

    private async send(mutation: Mutation): Promise<Response> {
        const isRoot =
            mutation.kind === 'addRoot' || mutation.kind === 'removeRoot';
        const method =
            mutation.kind === 'add' || mutation.kind === 'addRoot'
                ? 'POST'
                : 'DELETE';
        const body = isRoot
            ? JSON.stringify({ path: mutation.paths[0] })
            : JSON.stringify({ paths: mutation.paths });
        const url = isRoot
            ? '/api/config/workspace-roots'
            : '/api/config/workspaces';
        const scope = (this.app as any)?.scope;
        const fetchFn =
            typeof scope?.fetch === 'function'
                ? (input: string, init: RequestInit) => scope.fetch(input, init)
                : (input: string, init: RequestInit) => fetch(input, init);
        return fetchFn(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body,
        });
    }

    /** A read can reconcile a write, but must never trigger another send. */
    private async checkStatus(confirmed = false): Promise<void> {
        if (this.checking || !this.pending || !this.isCurrent()) return;
        const mutation = this.pending;
        const scope = this.scope;
        this.checking = true;
        this.setStatus('Checking the server…');
        const ok = await this.sessions.loadConfig({ refreshPanels: false });
        if (!this.isCurrent(scope) || this.pending !== mutation) return;
        this.checking = false;
        if (!ok) {
            this.pendingState = 'unconfirmed';
            this.setStatus(
                confirmed
                    ? 'Saved on the server. The reload failed; check status when connected.'
                    : 'Change not confirmed. Nothing was resent. Check status when connected.',
                'error',
            );
            return;
        }
        this.pending = null;
        this.pendingState = 'idle';
        this.writeOutbox(null);
        this.syncFromConfig();
        if (confirmed) this.setStatus('Saved.');
        else this.setReconcileStatus(mutation);
        if (this.isOpen()) void this.loadRoots(this.generation);
    }

    /**
     * What the reloaded config proves about a write. `null` means the stored
     * list cannot answer it, so the message must not claim an outcome.
     */
    private mutationLanded(mutation: Mutation | null): boolean | null {
        if (!mutation) return null;
        const roots = this.rootPaths;
        switch (mutation.kind) {
            case 'add':
                return mutation.paths.every((path) =>
                    this.sessions.isWorkspaceRegistered(path),
                );
            case 'remove':
                return mutation.paths.every(
                    (path) => !this.sessions.isWorkspaceRegistered(path),
                );
            case 'addRoot': {
                const path = mutation.paths[0] ?? '';
                if (roots.includes(path)) return true;
                // A typed "~/code" was stored expanded, so it cannot be matched.
                return path.startsWith('~') ? null : false;
            }
            case 'removeRoot':
                return mutation.paths.every((path) => !roots.includes(path));
        }
    }

    private setReconcileStatus(mutation: Mutation | null): void {
        const landed = this.mutationLanded(mutation);
        if (landed === false) {
            this.setStatus(
                'This change is not in the current server state. Nothing was resent.',
                'error',
            );
            return;
        }
        this.setStatus(
            landed === true
                ? 'Saved.'
                : 'Server state reloaded. Nothing was resent.',
        );
    }

    /** Only never-started work may be sent. Persist ambiguity BEFORE fetch. */
    private async flushPending(): Promise<void> {
        const mutation = this.pending;
        const scope = this.scope;
        if (
            !mutation ||
            this.pendingState !== 'unsent' ||
            !this.isOnline() ||
            !this.isCurrent(scope)
        )
            return;
        this.pendingState = 'sending';
        this.writeOutbox(mutation, 'unconfirmed');
        this.status = '';
        this.statusTone = 'info';
        this.render();
        let response: Response;
        try {
            response = await this.send(mutation);
        } catch {
            if (!this.isCurrent(scope) || this.pending !== mutation) return;
            this.pendingState = 'unconfirmed';
            this.setStatus(
                'Change not confirmed. It may or may not have been saved.',
                'error',
            );
            await this.checkStatus();
            return;
        }
        if (!this.isCurrent(scope) || this.pending !== mutation) return;
        if (!response.ok) {
            const message = await response.text().catch(() => '');
            if (!this.isCurrent(scope) || this.pending !== mutation) return;
            this.pending = null;
            this.pendingState = 'idle';
            this.writeOutbox(null);
            this.syncFromConfig();
            this.setStatus(
                message.trim() || 'The server rejected the change.',
                'error',
            );
            return;
        }
        if (
            mutation.kind === 'addRoot' &&
            this.rootInput?.value.trim() === mutation.paths[0]
        ) {
            this.rootInput.value = '';
        }
        await this.checkStatus(true);
    }

    private restoreOutbox(): void {
        if (this.pending) return;
        const stored = this.readOutbox();
        if (!stored) return;
        this.pending = stored.mutation;
        this.pendingState = stored.state;
        this.status =
            stored.state === 'unsent'
                ? 'Saved in this browser. It is sent when the server is reachable.'
                : 'Change not confirmed. It may or may not have been saved.';
        this.statusTone = stored.state === 'unsent' ? 'info' : 'error';
    }

    private readOutbox(): { mutation: Mutation; state: PendingState } | null {
        if (typeof localStorage === 'undefined') return null;
        try {
            const raw = localStorage.getItem(this.outboxKey());
            if (!raw) return null;
            const parsed = JSON.parse(raw) as any;
            const kinds: MutationKind[] = [
                'add',
                'remove',
                'addRoot',
                'removeRoot',
            ];
            if (!kinds.includes(parsed?.kind)) return null;
            const paths = Array.isArray(parsed.paths)
                ? parsed.paths.filter(isString)
                : [];
            if (paths.length === 0) return null;
            const state: PendingState =
                parsed.state === 'unsent' ? 'unsent' : 'unconfirmed';
            return { mutation: { kind: parsed.kind, paths }, state };
        } catch {
            return null;
        }
    }

    private writeOutbox(
        mutation: Mutation | null,
        state: PendingState = 'unsent',
    ): void {
        if (typeof localStorage === 'undefined') return;
        try {
            if (mutation) {
                localStorage.setItem(
                    this.outboxKey(),
                    JSON.stringify({ ...mutation, state }),
                );
            } else {
                localStorage.removeItem(this.outboxKey());
            }
        } catch {
            /* storage unavailable: the in-memory state still applies */
        }
    }

    private outboxKey(): string {
        return this.storageKey;
    }
}
