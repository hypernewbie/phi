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
    private status = '';
    /** Lower-cased local filter. Never touches server state or selection. */
    private filter = '';
    private rowSeq = 0;
    private readonly onOnline = (): void => {
        void this.flushPending();
    };

    constructor(app: AppLike, sessions: SessionsManager) {
        this.app = app;
        this.sessions = sessions;
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
        this.rootsContainer = byId('ws-manager-roots');

        this.closeBtn?.addEventListener('click', () => this.close());
        this.doneBtn?.addEventListener('click', () => this.close());
        this.removeBtn?.addEventListener('click', () => void this.removeSelected());
        this.projectsAll?.addEventListener('change', () => {
            this.projectSelection.clear();
            const rows = this.sessions.workspaces;
            if (this.projectsAll?.checked) {
                for (const row of rows) this.projectSelection.add(row);
            }
            this.applyProjectControls();
        });
        this.rootAddBtn?.addEventListener('click', () => void this.addRoot());
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
        return (
            !!this.overlay && !this.overlay.classList.contains('hidden')
        );
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
        this.rowSeq = 0;
        this.filter = '';
        if (this.filterInput) this.filterInput.value = '';
        this.projectSelection.clear();
        this.syncFromConfig();
        this.restoreOutbox();
        this.overlay.classList.remove('hidden');
        this.render();
        this.trap = trapModalFocus(this.overlay, {
            onEscape: () => this.close(),
            isOpen: () => this.isOpen(),
            initialFocus: () => this.projectsList ?? this.overlay,
        });
        (this.projectsList ?? this.overlay).focus?.({ preventScroll: true });
        void this.refresh();
    }

    close(): void {
        if (!this.overlay || !this.isOpen()) return;
        // A started write keeps running: closing is a view action, never a
        // cancel, so an in-flight config change is not silently dropped.
        this.generation++;
        this.trap?.dispose();
        this.trap = null;
        this.overlay.classList.add('hidden');
        const opener = this.opener;
        this.opener = null;
        if (opener?.isConnected) opener.focus({ preventScroll: true });
    }

    /** Re-reads the config payload and every root listing behind the dialog. */
    async refresh(): Promise<void> {
        const generation = this.generation;
        this.syncFromConfig();
        this.render();
        const loadConfig = this.sessions.loadConfig;
        if (typeof loadConfig === 'function') {
            const ok = await this.sessions.loadConfig();
            if (generation !== this.generation) return;
            if (ok) this.syncFromConfig();
        }
        if (generation !== this.generation) return;
        this.render();
        await this.loadRoots(generation);
    }

    private syncFromConfig(): void {
        const raw = (this.sessions.config as any)?.workspace_roots;
        const roots = Array.isArray(raw) ? raw.filter(isString) : [];
        this.rootPaths = roots.slice();
        for (const path of roots) {
            if (!this.rootPaths.includes(path)) this.rootPaths.push(path);
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
            if (!this.rootPaths.includes(path)) this.sections.delete(path);
        }
        for (const section of this.sections.values()) this.partition(section);
        const registered = new Set(this.sessions.workspaces);
        for (const path of Array.from(this.projectSelection)) {
            if (!registered.has(path)) this.projectSelection.delete(path);
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
        await Promise.allSettled(
            this.rootPaths.map((path) => this.loadRoot(path, generation)),
        );
    }

    private async loadRoot(path: string, generation: number): Promise<void> {
        const section = this.sections.get(path);
        if (!section) return;
        if (!section.rows.length) section.loading = true;
        this.render();

        const url = `/api/fs/browse?path=${encodeURIComponent(path)}`;
        const scope = (this.app as any)?.scope;
        const store = (this.app as any)?.getActiveStore?.();
        const render = (data: BrowseResponse): void => {
            if (generation !== this.generation) return;
            this.applyBrowse(section, data);
        };

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
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                data = (await res.json()) as BrowseResponse;
            }
            if (generation !== this.generation) return;
            if (!data) return;
            this.applyBrowse(section, data);
            section.loading = false;
            section.error = '';
        } catch (error: any) {
            if (generation !== this.generation) return;
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
        this.partition(section);
    }

    private render(): void {
        this.renderStatus();
        this.renderProjects();
        this.renderRoots();
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
            check.className = 'btn ws-manager-check-btn';
            check.textContent = 'Check status';
            check.addEventListener('click', () => void this.checkStatus());
            this.statusEl.appendChild(check);
            if (!text.textContent) {
                text.textContent =
                    'Change not confirmed. It may or may not have been saved.';
            }
        }
        this.statusEl.dataset.state = this.pendingState;
    }

    private renderProjects(): void {
        if (!this.projectsList) return;
        const workspaces = this.sessions.workspaces;
        this.projectsList.replaceChildren();
        if (this.projectsCount) {
            this.projectsCount.textContent = `(${workspaces.length})`;
        }
        for (const path of Array.from(this.projectSelection)) {
            if (!workspaces.includes(path)) this.projectSelection.delete(path);
        }
        if (workspaces.length === 0) {
            this.projectsList.appendChild(
                this.emptyNote('No workspaces yet.'),
            );
        } else if (this.visibleProjects().length === 0) {
            this.projectsList.appendChild(
                this.emptyNote('No projects match the filter.'),
            );
        }
        for (const path of this.visibleProjects()) {
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
            head.className = 'ws-manager-section-head';
            head.appendChild(title);

            const allLabel = document.createElement('label');
            allLabel.className = 'ws-manager-all';
            const allBox = document.createElement('input');
            allBox.type = 'checkbox';
            const allText = document.createElement('span');
            allText.textContent = 'All';
            allLabel.append(allBox, allText);
            allBox.addEventListener('change', () => {
                section.selection.clear();
                if (allBox.checked) {
                    for (const row of this.visibleRows(section)) {
                        section.selection.add(row);
                    }
                }
                this.applySectionControls(section, element);
            });
            head.appendChild(allLabel);

            const removeRoot = document.createElement('button');
            removeRoot.type = 'button';
            removeRoot.className = 'btn ws-manager-root-remove';
            removeRoot.textContent = 'Remove root';
            removeRoot.disabled = this.isPending();
            removeRoot.addEventListener('click', () =>
                void this.removeRoot(path),
            );
            head.appendChild(removeRoot);
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
                retry.className = 'btn ws-manager-retry-btn';
                retry.textContent = 'Retry';
                retry.addEventListener('click', () =>
                    void this.loadRoot(path, this.generation),
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
            actions.className = 'ws-manager-actions';
            const add = document.createElement('button');
            add.type = 'button';
            add.className = 'btn btn-accent';
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
        const selected = visible.filter((path) =>
            section.selection.has(path),
        );
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
            '.ws-manager-actions .btn',
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
        const all = Array.from(
            new Set([...this.sessions.workspaces, ...this.rootPaths]),
        );
        return formatWorkspaceLabel(path, all);
    }

    private isBusy(): boolean {
        return this.pendingState === 'sending';
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

    private setStatus(text: string): void {
        this.status = text;
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

    /** Applies a mutation locally, then sends it under the offline rules. */
    private async mutate(mutation: Mutation): Promise<void> {
        if (this.isPending()) return;
        const before = this.sessions.workspaces.slice();
        this.pending = mutation;
        this.status = '';
        this.applyLocal(mutation);

        if (!this.isOnline()) {
            this.pendingState = 'unsent';
            this.writeOutbox(mutation, 'unsent');
            this.setStatus(
                'Saved in this browser. It is sent when the server is reachable.',
            );
            return;
        }

        this.pendingState = 'sending';
        this.render();
        let response: Response;
        try {
            response = await this.send(mutation);
        } catch {
            await this.markUnconfirmed(mutation);
            return;
        }
        if (!response.ok) {
            const message = await response.text().catch(() => '');
            this.sessions.applyWorkspaceList(before);
            this.pending = null;
            this.pendingState = 'idle';
            this.writeOutbox(null);
            this.syncFromConfig();
            this.setStatus(
                message.trim() || 'The server rejected the change.',
            );
            return;
        }

        this.writeOutbox(null);
        this.pending = null;
        this.pendingState = 'idle';
        await this.confirm();
    }

    private applyLocal(mutation: Mutation): void {
        switch (mutation.kind) {
            case 'add': {
                const next = this.sessions.workspaces.slice();
                for (const path of mutation.paths) {
                    if (!next.includes(path)) next.push(path);
                }
                this.sessions.applyWorkspaceList(next);
                break;
            }
            case 'remove':
                this.sessions.applyWorkspaceList(
                    this.sessions.workspaces.filter(
                        (path) => !mutation.paths.includes(path),
                    ),
                );
                break;
            case 'addRoot': {
                const path = mutation.paths[0];
                if (path && !this.rootPaths.includes(path)) {
                    this.rootPaths.push(path);
                    this.sections.set(path, {
                        path,
                        allRows: [],
                        rows: [],
                        selection: new Set(),
                        loading: true,
                        error: '',
                        truncated: false,
                    });
                }
                break;
            }
            case 'removeRoot':
                this.rootPaths = this.rootPaths.filter(
                    (path) => !mutation.paths.includes(path),
                );
                for (const path of mutation.paths) this.sections.delete(path);
                break;
        }
        if (this.rootInput && mutation.kind === 'addRoot') {
            this.rootInput.value = '';
        }
        // Registered children leave their root section at once, not one
        // round-trip later. The selection survives: a rejected write restores
        // it, and a confirmed one prunes it during reconcile.
        for (const section of this.sections.values()) {
            this.partition(section, false);
        }
        this.render();
    }

    private async send(mutation: Mutation): Promise<Response> {
        const isRoot = mutation.kind === 'addRoot' || mutation.kind === 'removeRoot';
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

    /** Reconciles after a confirmed write and refreshes the root listings. */
    private async confirm(): Promise<void> {
        const generation = this.generation;
        const ok = await this.sessions.loadConfig();
        if (generation === this.generation) {
            if (ok) {
                // The write landed, so config is authoritative: a root the user
                // typed as "~/code" now appears under its expanded path.
                this.syncFromConfig();
            } else {
                this.status =
                    'Saved on the server. The reload failed, so this view may be behind.';
            }
            this.render();
            await this.loadRoots(generation);
        }
    }

    /** The request started and never answered: it may have arrived. */
    private async markUnconfirmed(mutation: Mutation): Promise<void> {
        this.pending = mutation;
        this.pendingState = 'unconfirmed';
        this.writeOutbox(mutation, 'unconfirmed');
        this.setStatus(
            'Change not confirmed. It may or may not have been saved.',
        );
        const ok = await this.sessions.loadConfig();
        if (ok) {
            this.syncFromConfig();
            this.pending = null;
            this.pendingState = 'idle';
            this.writeOutbox(null);
            this.setStatus('Server state reloaded.');
        }
    }

    /** "Check status": a read-only reconciliation, never a resend. */
    private async checkStatus(): Promise<void> {
        this.setStatus('Checking the server…');
        const ok = await this.sessions.loadConfig();
        if (!ok) {
            this.setStatus(
                'The server is still unreachable. Nothing was resent.',
            );
            return;
        }
        this.syncFromConfig();
        this.pending = null;
        this.pendingState = 'idle';
        this.writeOutbox(null);
        this.setStatus('Server state reloaded. Nothing was resent.');
        await this.loadRoots(this.generation);
    }

    /** Flushes the one write that never reached the server. */
    private async flushPending(): Promise<void> {
        const mutation = this.pending;
        if (!mutation || this.pendingState !== 'unsent') return;
        this.pendingState = 'sending';
        this.status = '';
        this.render();
        let response: Response;
        try {
            response = await this.send(mutation);
        } catch {
            this.pendingState = 'unconfirmed';
            this.writeOutbox(mutation, 'unconfirmed');
            this.setStatus(
                'Change not confirmed. It may or may not have been saved.',
            );
            return;
        }
        if (!response.ok) {
            // The server refused the queued change: drop the local result and
            // take its state as the truth.
            this.pending = null;
            this.pendingState = 'idle';
            this.writeOutbox(null);
            const ok = await this.sessions.loadConfig();
            if (ok) this.syncFromConfig();
            this.render();
            this.setStatus('The server rejected the queued change.');
            return;
        }
        this.pending = null;
        this.pendingState = 'idle';
        this.writeOutbox(null);
        await this.confirm();
    }

    private restoreOutbox(): void {
        const stored = this.readOutbox();
        if (!stored) return;
        this.pending = stored.mutation;
        this.pendingState = stored.state;
        this.applyLocal(stored.mutation);
        if (stored.state === 'unconfirmed') {
            // A write from a previous page may have arrived. Never resend it.
            this.status =
                'Change not confirmed. It may or may not have been saved.';
        }
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
                parsed.state === 'unconfirmed' ? 'unconfirmed' : 'unsent';
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
        return serverKey(OUTBOX_KEY);
    }
}
