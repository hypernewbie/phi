import type { AppLike } from './types.js';
import {
    mountDirectoryTree,
    type DirectoryTreeController,
} from './path-picker.js';
import {
    escapeHtml,
    getLastFolderName as getLastFolderNameUtil,
    formatWorkspaceLabel as formatWorkspaceLabelUtil,
    worktreeGlyph,
    displayHostname,
    isCompactViewport,
    serverKey,
    getEmbeddedBackendOrigin,
    getEmbeddedProfileId,
} from './util.js';
import { openPiRpcChatTab } from './chat-pi/tab.js';
import { openDshPreviewTab, refreshDshLauncher } from './dsh-tab.js';
import { createReviewTranscriptView } from './review-transcript.js';
import {
    loadCoderRegistry,
    openCodePaneMode,
    visibleCoders,
    getCoder,
    hasTranscript,
    hasPiRpc,
    hasRename,
    hasSessions,
    isShell,
    renderLogo,
    RESERVED_CODER_IDS,
} from './coders.js';

export function normalizePath(p: string): string {
    if (!p) return '';
    let normalized = p.replace(/\\/g, '/');
    // Windows extended-length paths (`\\?\C:\work`,
    // `\\?\UNC\srv\share`) denote the same locations as their plain
    // forms. Codex records thread cwds this way, so collapse the
    // prefix before comparing against workspace paths.
    if (normalized.startsWith('//?/')) {
        const rest = normalized.slice(4);
        normalized = /^unc\//i.test(rest) ? `//${rest.slice(4)}` : rest;
    }
    if (normalized.endsWith('/') && normalized.length > 1) {
        normalized = normalized.slice(0, -1);
    }
    return normalized.toLowerCase();
}

// Built-in sidebar labels and launch order are a UI contract, not the
// registry's storage order. Custom profiles follow the built-ins.
const BUILTIN_TAB_TITLES = new Map([
    ['opencode', 'OpenCode'],
    ['claude', 'Claude Code'],
    ['agy', 'Antigravity / Agy'],
    ['pi', 'Pi (term)'],
    ['codex', 'OpenAI Codex'],
    ['bash', 'Shell Prompt'],
]);
const QUICK_LAUNCH_ORDER = ['opencode', 'claude', 'pi', 'agy', 'codex', 'bash'];
const BUILTIN_SESSION_TITLES = new Map([
    ['opencode', 'OpenCode'],
    ['claude', 'Claude'],
    ['pi', 'Pi'],
    ['agy', 'Agy'],
    ['codex', 'Codex'],
    ['bash', 'Shell'],
    ['pwsh', 'Shell'],
]);

// sessionsUrl is the single source of the paginated session list URL: every
// fetch, cache write, and cache lookup must produce the same string.
function sessionsUrl(
    coder: string,
    cwd: string,
    limit: number,
    offset = 0,
): string {
    return `/api/sessions?coder=${encodeURIComponent(coder)}&cwd=${encodeURIComponent(cwd)}&limit=${limit}&offset=${offset}`;
}

const SESSION_CACHE_PREFIX = 'phi_session_cache_v1';
const SESSION_REQUEST_TIMEOUT_MS = 45_000;
const MAX_SESSION_CACHE_ENTRY_LENGTH = 262_144;
const blockedSessionProfiles = new Set<string>();
const recoveredSessionNamespaces = new Set<string>();
const unconfirmedSessionRemovals = new Set<string>();
const sessionCacheEpochs = new Map<string, number>();
const blockedSessionNamespaces = new Set<string>();
const sessionNamespacesByProfile = new Map<string, Set<string>>();

type SessionCacheIdentity = {
    origin: string;
    profileId: string;
    namespace: string;
    key: string;
};

type SessionRequestResult = 'updated' | 'failed' | 'editing' | 'superseded';

type SessionListSnapshot = {
    sections: Map<string, { expanded: boolean; offset: number }>;
    focus?: { path: string; delta: string };
};

type SessionCacheValidator = (value: unknown) => boolean;

function sessionCacheIdentity(
    scope: any,
    url: string,
): SessionCacheIdentity | null {
    const profileId =
        typeof scope?.profileId === 'string'
            ? scope.profileId
            : getEmbeddedProfileId();
    const rawOrigin =
        (typeof scope?.origin === 'string' && scope.origin) ||
        getEmbeddedBackendOrigin() ||
        (typeof window !== 'undefined' ? window.location?.origin : '');
    let origin: string;
    try {
        origin = new URL(rawOrigin).origin;
        if (!origin || origin === 'null') return null;
    } catch {
        return null;
    }
    const encodedOrigin = encodeURIComponent(origin);
    const encodedUrl = encodeURIComponent(url);
    const encodedProfile = encodeURIComponent(profileId);
    const namespace = `${encodedOrigin}:${encodedProfile}`;
    let profiles = sessionNamespacesByProfile.get(profileId);
    if (!profiles) {
        profiles = new Set();
        sessionNamespacesByProfile.set(profileId, profiles);
    }
    profiles.add(namespace);
    return {
        origin,
        profileId,
        namespace,
        key: `${SESSION_CACHE_PREFIX}:${encodedOrigin}:${encodedUrl}:${encodedProfile}`,
    };
}

function sessionCacheEpoch(namespace: string | undefined): number {
    return namespace ? (sessionCacheEpochs.get(namespace) ?? 0) : 0;
}

function sessionCacheBlocked(identity: SessionCacheIdentity): boolean {
    return (
        blockedSessionNamespaces.has(identity.namespace) ||
        (blockedSessionProfiles.has(identity.profileId) &&
            !recoveredSessionNamespaces.has(identity.namespace))
    );
}

function recoverSessionNamespace(identity: SessionCacheIdentity): void {
    blockedSessionNamespaces.delete(identity.namespace);
    if (blockedSessionProfiles.has(identity.profileId))
        recoveredSessionNamespaces.add(identity.namespace);
    unconfirmedSessionRemovals.delete(identity.namespace);
}

function isSessionPage(value: unknown, limit: number): value is any[] {
    if (!Array.isArray(value) || value.length > limit) return false;
    return value.every((session) => {
        if (!session || typeof session !== 'object' || Array.isArray(session)) {
            return false;
        }
        if (
            typeof session.id !== 'string' ||
            session.id.length === 0 ||
            typeof session.title !== 'string' ||
            typeof session.time_updated !== 'string' ||
            !Number.isFinite(Date.parse(session.time_updated))
        ) {
            return false;
        }
        return ['cwd', 'coder', 'session_path'].every(
            (key) => !(key in session) || typeof session[key] === 'string',
        );
    });
}

function normalizeWorktrees(value: unknown): any[] | null {
    if (value === null) return [];
    if (!Array.isArray(value)) return null;
    for (const worktree of value) {
        if (
            !worktree ||
            typeof worktree !== 'object' ||
            Array.isArray(worktree) ||
            typeof worktree.path !== 'string' ||
            worktree.path.length === 0 ||
            ('branch' in worktree && typeof worktree.branch !== 'string') ||
            ('active' in worktree && typeof worktree.active !== 'boolean') ||
            ('expanded' in worktree && typeof worktree.expanded !== 'boolean')
        ) {
            return null;
        }
    }
    return value;
}

function featureKeyNamespace(key: string): string | null {
    const parts = key.split(':');
    return parts.length === 4 && parts[0] === SESSION_CACHE_PREFIX
        ? `${parts[1]}:${parts[3]}`
        : null;
}

function parseFeatureCache(
    raw: unknown,
    validate: SessionCacheValidator,
): any | null {
    if (typeof raw !== 'string') return null;
    try {
        const envelope = JSON.parse(raw);
        return envelope?.v === 1 &&
            typeof envelope.saved_at === 'number' &&
            Number.isFinite(envelope.saved_at) &&
            envelope.saved_at >= 0 &&
            validate(envelope.data)
            ? envelope.data
            : null;
    } catch {
        return null;
    }
}

function readFeatureCache(
    store: any,
    identity: SessionCacheIdentity | null,
    validate: SessionCacheValidator,
): any | null {
    if (!identity || sessionCacheBlocked(identity)) return null;
    try {
        const memory = parseFeatureCache(
            store?.responses?.get?.(identity.key),
            validate,
        );
        if (memory !== null) return memory;
    } catch {
        /* Disk fallback remains available when memory is corrupt. */
    }
    try {
        const raw = localStorage.getItem(identity.key);
        if (!raw || raw.length > MAX_SESSION_CACHE_ENTRY_LENGTH) return null;
        const data = parseFeatureCache(raw, validate);
        if (data !== null) {
            try {
                store?.responses?.set?.(identity.key, raw);
            } catch {
                /* A valid disk answer still renders when memory caching fails. */
            }
        }
        return data;
    } catch {
        return null;
    }
}

function writeFeatureCache(
    store: any,
    identity: SessionCacheIdentity | null,
    data: unknown,
    validate: SessionCacheValidator,
    onStorageFailure: () => void,
): void {
    if (
        !identity ||
        !validate(data) ||
        sessionCacheBlocked(identity) ||
        !store?.responses
    )
        return;
    let raw: string;
    try {
        raw = JSON.stringify({ v: 1, saved_at: Date.now(), data });
        store.responses.set(identity.key, raw);
    } catch {
        return;
    }
    const epoch = sessionCacheEpoch(identity.namespace);
    // The accepted value survives its own root rebuild, but not a newer answer or purge.
    setTimeout(() => {
        if (
            epoch !== sessionCacheEpoch(identity.namespace) ||
            sessionCacheBlocked(identity) ||
            store.responses.get(identity.key) !== raw
        )
            return;
        if (raw.length > MAX_SESSION_CACHE_ENTRY_LENGTH) {
            onStorageFailure();
            return;
        }
        try {
            localStorage.setItem(identity.key, raw);
        } catch {
            onStorageFailure();
        }
    }, 0);
}

function removeFeatureCache(store: any, namespace: string): boolean {
    let removed = true;
    try {
        const responses = store?.responses;
        for (const key of responses?.keys?.() ?? []) {
            if (
                typeof key === 'string' &&
                featureKeyNamespace(key) === namespace
            )
                responses.delete(key);
        }
    } catch {
        removed = false;
    }
    try {
        for (let i = localStorage.length - 1; i >= 0; i--) {
            const key = localStorage.key(i);
            if (key && featureKeyNamespace(key) === namespace)
                localStorage.removeItem(key);
        }
    } catch {
        removed = false;
    }
    return removed;
}

// readCachedSessions returns the last good, namespaced page or null.
function readCachedSessions(
    store: any,
    scope: any,
    url: string,
    limit: number,
): any[] | null {
    return readFeatureCache(store, sessionCacheIdentity(scope, url), (value) =>
        isSessionPage(value, limit),
    );
}

function focusPagerButton(container: HTMLElement, delta: string): void {
    const preferred = container.querySelector<HTMLButtonElement>(
        `.session-page[data-page="${delta}"]`,
    );
    if (preferred && !preferred.disabled) {
        preferred.focus({ preventScroll: true });
        return;
    }
    container
        .querySelector<HTMLButtonElement>('.session-page:not(:disabled)')
        ?.focus({ preventScroll: true });
}

export class SessionsManager {
    app: AppLike;
    activeCoder: string;
    quickLaunchReady: boolean;
    activeWorkspace: string;
    activeCWD: string;
    config: any;
    sessionList: HTMLElement;
    newSessionBtn: HTMLElement;
    openCodeServiceRow: HTMLElement | null;
    openCodeServiceBtn: HTMLButtonElement | null;
    dshPreviewBtn: HTMLButtonElement | null;
    _openCodeServicePollTimer: number | null = null;
    workspaceSelect: HTMLSelectElement;
    addWorkspaceBtn: HTMLElement;
    removeWorkspaceBtn: HTMLElement;
    wsModal: HTMLElement;
    wsModalClose: HTMLElement;
    wsModalInput: HTMLInputElement;
    wsModalBrowseBtn: HTMLButtonElement;
    wsModalTree: HTMLElement;
    wsModalPathStatus: HTMLElement;
    wsModalSuggestions: HTMLElement;
    wsModalCancelBtn: HTMLElement;
    wsModalAddBtn: HTMLButtonElement;
    selectedSuggestionIndex: number;
    wsTreeController: DirectoryTreeController | null;
    wsDialogGeneration: number;
    wsDraftGeneration: number;
    wsAutocompleteRequestId: number;
    wsPathResolveId: number;
    wsSubmitPending: boolean;
    wsSubmitOperationId: number;
    wsSubmitPostStarted: boolean;
    wsModalComposing: boolean;
    wsModalOpener: HTMLElement | null;
    wsModalKeydownHandler: ((event: KeyboardEvent) => void) | null;
    wsModalFocusinHandler: ((event: FocusEvent) => void) | null;
    worktreeDirtyRequestId: number;
    worktreeLoadRequestId: number;
    worktreeRootGeneration: number;
    worktreeRootOwner: {
        scope: any;
        coder: string;
        workspace: string;
    } | null;
    sessionRequests: Map<
        HTMLElement,
        {
            controller: AbortController;
            cancel: (kind: 'owner' | 'timeout' | 'auth') => void;
            namespace: string;
            profileId: string;
            requestId: string;
            offset: number;
            store: any;
        }
    >;
    worktreeReads: Map<
        'list' | 'dirty',
        {
            cancel: (kind: 'owner' | 'timeout' | 'auth') => void;
            namespace: string;
            profileId: string;
            store: any;
        }
    >;
    sessionRefreshPromise: Promise<void> | null;
    sessionRefreshGeneration: number;
    sessionListPageSize = 10;
    _measureSpan: HTMLElement | null = null;
    _contextMenu: HTMLElement | null;
    _ctxDismissMousedown: ((ev: MouseEvent) => void) | null;
    _ctxDismissKey: ((ev: KeyboardEvent) => void) | null;

    constructor(app: AppLike) {
        this.app = app;
        this.activeCoder = 'opencode';
        // The old App wired quick-launch clicks only after its initial
        // config and tab restore. Keep the same enablement point.
        this.quickLaunchReady = false;
        this.activeWorkspace = '';
        this.activeCWD = '';

        this.sessionList = document.getElementById('session-list')!;
        this.newSessionBtn = document.getElementById('new-session-btn')!;
        this.openCodeServiceRow = document.getElementById(
            'opencode-service-row',
        );
        this.openCodeServiceBtn = document.getElementById(
            'opencode-service-btn',
        ) as HTMLButtonElement | null;
        this.dshPreviewBtn = document.getElementById(
            'dsh-preview-btn',
        ) as HTMLButtonElement | null;

        // Workspace Controls
        this.workspaceSelect = document.getElementById(
            'workspace-select',
        ) as HTMLSelectElement;
        this.addWorkspaceBtn = document.getElementById('add-workspace-btn')!;
        this.removeWorkspaceBtn = document.getElementById(
            'remove-workspace-btn',
        )!;

        // Workspace Modal Controls
        this.wsModal = document.getElementById('ws-modal')!;
        this.wsModalClose = document.getElementById('ws-modal-close')!;
        this.wsModalInput = document.getElementById(
            'ws-modal-input',
        ) as HTMLInputElement;
        this.wsModalBrowseBtn = document.getElementById(
            'ws-modal-browse-btn',
        ) as HTMLButtonElement;
        this.wsModalTree = document.getElementById('ws-modal-tree')!;
        this.wsModalPathStatus = document.getElementById(
            'ws-modal-path-status',
        )!;
        this.wsModalSuggestions = document.getElementById(
            'ws-modal-suggestions',
        )!;
        this.wsModalCancelBtn = document.getElementById('ws-modal-cancel-btn')!;
        this.wsModalAddBtn = document.getElementById(
            'ws-modal-add-btn',
        ) as HTMLButtonElement;
        this.selectedSuggestionIndex = -1;
        this.wsTreeController = null;
        this.wsDialogGeneration = 0;
        this.wsDraftGeneration = 0;
        this.wsAutocompleteRequestId = 0;
        this.wsPathResolveId = 0;
        this.wsSubmitPending = false;
        this.wsSubmitOperationId = 0;
        this.wsSubmitPostStarted = false;
        this.wsModalComposing = false;
        this.wsModalOpener = null;
        this.wsModalKeydownHandler = null;
        this.wsModalFocusinHandler = null;
        this.worktreeDirtyRequestId = 0;
        this.worktreeLoadRequestId = 0;
        this.worktreeRootGeneration = 0;
        this.worktreeRootOwner = null;
        this.sessionRequests = new Map();
        this.worktreeReads = new Map();
        this.sessionRefreshPromise = null;
        this.sessionRefreshGeneration = 0;
        this._contextMenu = null;
        this._ctxDismissMousedown = null;
        this._ctxDismissKey = null;

        this.setupEventListeners();
    }

    setupEventListeners(): void {
        // Coder Selector Tabs: delegated handler on the stable
        // #coder-selector container. The previous code bound a click
        // listener to each static .coder-tab in the constructor —
        // that broke once we made the container dynamic. The
        // delegated listener survives re-renders. (R9)
        const refreshButton = document.getElementById(
            'refresh-sessions-btn',
        ) as HTMLButtonElement | null;
        refreshButton?.addEventListener('click', () => {
            void this.refreshSessions();
        });
        refreshButton?.addEventListener('pointerdown', (event) => {
            if (event.button === 0 && this.hasSessionDraft())
                event.preventDefault();
        });
        this.sessionList.addEventListener(
            'blur',
            (event) => {
                const target = event.target;
                if (
                    target instanceof HTMLElement &&
                    target.matches('.rename-input') &&
                    event.relatedTarget === refreshButton
                ) {
                    event.stopImmediatePropagation();
                }
            },
            true,
        );
        this.updateRefreshButtonVisibility();

        const coderContainer = document.getElementById('coder-selector');
        if (coderContainer) {
            coderContainer.addEventListener('click', (e) => {
                const target = (e.target as Element | null)?.closest(
                    '.coder-tab',
                ) as HTMLElement | null;
                if (!target) return;
                const id = target.getAttribute('data-coder');
                if (!id) return;
                coderContainer
                    .querySelector('.coder-tab.active')
                    ?.classList.remove('active');
                target.classList.add('active');
                if (this.activeCoder !== id) this.onSessionContextChange();
                this.activeCoder = id;
                this.updateRefreshButtonVisibility();
                if (isShell(id) && this.quickLaunchReady) {
                    this.spawnNewSession();
                } else {
                    this.loadSessions();
                }
                this.updateOpenCodeServiceVisibility?.();
            });
            coderContainer.addEventListener('contextmenu', (e) => {
                const target = (e.target as Element | null)?.closest(
                    '.coder-tab[data-coder="opencode"]',
                );
                if (
                    !target ||
                    !this.quickLaunchReady ||
                    !this._canOpenCodeMini()
                )
                    return;
                e.preventDefault();
                this._showOpenCodeMiniMenu(e, () => {
                    this.switchCoder('opencode');
                    this.spawnNewSession(true);
                });
            });
        }

        // Empty-state quick launch buttons: same delegated pattern
        // for the same re-render reason. The previous code bound a
        // listener to each button in app.js, which only ran once.
        const emptyQuickLaunch = document.getElementById('empty-quick-launch');
        if (emptyQuickLaunch) {
            emptyQuickLaunch.addEventListener('click', (e) => {
                const target = (e.target as Element | null)?.closest(
                    '.empty-launch-btn',
                ) as HTMLElement | null;
                if (!target) return;
                const coder = target.getAttribute('data-coder');
                if (!coder || !this.quickLaunchReady) return;
                this.switchCoder(coder);
                this.spawnNewSession();
            });
            emptyQuickLaunch.addEventListener('contextmenu', (e) => {
                const target = (e.target as Element | null)?.closest(
                    '.empty-launch-btn[data-coder="opencode"]',
                );
                if (
                    !target ||
                    !this.quickLaunchReady ||
                    !this._canOpenCodeMini()
                )
                    return;
                e.preventDefault();
                this._showOpenCodeMiniMenu(e, () => {
                    this.switchCoder('opencode');
                    this.spawnNewSession(true);
                });
            });
        }

        // New Session Trigger
        this.newSessionBtn.addEventListener('click', () => {
            this.spawnNewSession();
        });
        // DSH preview launcher: visibility follows the cached server
        // status; the tab itself revalidates the mount on every open.
        this.dshPreviewBtn?.addEventListener('click', () => {
            if (isCompactViewport()) {
                document
                    .getElementById('sidebar-panel')
                    ?.classList.remove('drawer-open');
            }
            void openDshPreviewTab(this.app.tabManager);
        });
        void refreshDshLauncher(this.app?.scope);
        this.newSessionBtn.addEventListener('contextmenu', (e) => {
            if (
                this.activeCoder !== 'opencode' ||
                !this.quickLaunchReady ||
                !this._canOpenCodeMini()
            )
                return;
            e.preventDefault();
            this._showOpenCodeMiniMenu(e, () => {
                this.switchCoder('opencode');
                this.spawnNewSession(true);
            });
        });

        if (this.openCodeServiceBtn) {
            this.openCodeServiceBtn.addEventListener('click', () => {
                const state =
                    this.openCodeServiceBtn?.getAttribute('data-state');
                if (state === 'running') {
                    this.stopOpenCodeService(false);
                } else if (state === 'error') {
                    this.fetchOpenCodeServiceStatus();
                }
            });
        }
        document.addEventListener('visibilitychange', () => {
            if (
                document.visibilityState === 'visible' &&
                this.activeCoder === 'opencode'
            ) {
                this.fetchOpenCodeServiceStatus();
            }
        });

        // Workspace Toggle and Auto-Width Formatter
        this.workspaceSelect.addEventListener('change', () => {
            if (this.activeWorkspace !== this.workspaceSelect.value) {
                this.onSessionContextChange();
            }
            this.activeWorkspace = this.workspaceSelect.value;
            try {
                localStorage.setItem(
                    serverKey('phi_last_chosen_project'),
                    this.activeWorkspace,
                );
            } catch {
                /* Workspace selection must work without storage. */
            }
            this.updateWorkspaceSelectWidth();
            this.loadWorktrees();
            // Refresh diff on current active worktree (which is updated inside loadWorktrees)
            setTimeout(() => {
                this.app.diffController.refreshDiff();
                if (this.app.markdownManager) {
                    this.app.markdownManager.refreshFiles({ force: false });
                }
            }, 100);
        });
        window.addEventListener('resize', () =>
            this.updateWorkspaceSelectWidth(),
        );

        this.addWorkspaceBtn.addEventListener('click', () => {
            this.openWorkspaceModal();
        });

        this.removeWorkspaceBtn.addEventListener('click', () => {
            if (confirm(`Remove workspace: ${this.activeWorkspace}?`)) {
                this.removeWorkspace(this.activeWorkspace);
            }
        });

        // Modal Action Bindings
        this.wsModalClose.addEventListener('click', () =>
            this.closeWorkspaceModal(),
        );
        this.wsModalCancelBtn.addEventListener('click', () =>
            this.closeWorkspaceModal(),
        );
        this.wsModalAddBtn.addEventListener('click', () =>
            this.submitWorkspaceModal(),
        );
        this.wsModalBrowseBtn.addEventListener('click', () => {
            void this.revealWorkspacePath();
        });

        this.wsModalInput.addEventListener('compositionstart', () => {
            this.wsModalComposing = true;
        });
        this.wsModalInput.addEventListener('compositionend', () => {
            this.wsModalComposing = false;
        });
        this.wsModalInput.addEventListener('input', () => {
            this.onWorkspacePathInput();
        });
        this.wsModalInput.addEventListener('keydown', (event) => {
            this.onWorkspacePathKeydown(event);
        });
    }

    getLastFolderName(path: string): string {
        return getLastFolderNameUtil(path);
    }

    formatWorkspaceLabel(ws: string, allWorkspaces: readonly string[]): string {
        return formatWorkspaceLabelUtil(ws, allWorkspaces);
    }

    updateWorkspaceSelectWidth(): void {
        if (!this.workspaceSelect) return;
        const select = this.workspaceSelect;
        const active = this.activeWorkspace || select.value;

        // Label and empty-state text describe the active path, so they must
        // stay right even when there is nothing measurable to size.
        select.title = active || '';
        const emptyWs = document.getElementById('empty-workspace-path');
        if (emptyWs) emptyWs.textContent = active || 'Default';

        // A tab's workspace can name a cwd that is not a registered workspace
        // (worktree, entry removed from config). Setting .value to it leaves
        // selectedIndex -1 and renders a blank selector, while selecting a
        // registered workspace would label a project the app is not using.
        // Show the active path as a temporary option instead. It cannot
        // persist: /api/config rebuilds the list.
        for (const opt of Array.from(select.options)) {
            if (opt.dataset.transient) opt.remove();
        }
        const known = Array.from(select.options, (opt) => opt.value);
        if (active && !known.includes(active)) {
            const opt = document.createElement('option');
            opt.value = active;
            opt.textContent = this.formatWorkspaceLabel(active, [
                ...known,
                active,
            ]);
            opt.title = active;
            opt.dataset.transient = 'true';
            select.appendChild(opt);
            select.value = active;
        }

        // Nothing selectable: drop a width measured for a previous list.
        if (select.options.length === 0) {
            select.style.width = '';
            return;
        }
        if (
            select.selectedIndex < 0 ||
            select.selectedIndex >= select.options.length
        ) {
            select.selectedIndex = 0;
        }
        const idx = select.selectedIndex;
        const selectedOpt = idx >= 0 ? select.options[idx] : null;
        const text = selectedOpt
            ? selectedOpt.text || selectedOpt.innerText || selectedOpt.value
            : '';
        if (!text) return;

        if (!this._measureSpan) {
            this._measureSpan = document.createElement('span');
            this._measureSpan.style.position = 'absolute';
            this._measureSpan.style.visibility = 'hidden';
            this._measureSpan.style.height = '0';
            this._measureSpan.style.overflow = 'hidden';
            this._measureSpan.style.whiteSpace = 'pre';
            this._measureSpan.style.top = '-9999px';
            this._measureSpan.style.left = '-9999px';
            document.body.appendChild(this._measureSpan);
        }

        const style = window.getComputedStyle(this.workspaceSelect);
        this._measureSpan.style.fontFamily = style.fontFamily;
        this._measureSpan.style.fontSize = style.fontSize;
        this._measureSpan.style.fontWeight = style.fontWeight;
        this._measureSpan.style.letterSpacing = style.letterSpacing;

        this._measureSpan.textContent = text;
        const textWidth = this._measureSpan.getBoundingClientRect().width;

        const isMobile = isCompactViewport();
        const padding = isMobile ? 24 : 28;
        const calculatedWidth = Math.ceil(textWidth + padding);

        const minW = isMobile ? 50 : 60;
        const maxW = isMobile ? 130 : 280;

        const finalWidth = Math.max(minW, Math.min(maxW, calculatedWidth));
        select.style.width = `${finalWidth}px`;
    }

    applyConfigData(data: any, _options: { stale?: boolean } = {}): void {
        if (!data || typeof data !== 'object') return;
        this.config = data;
        if (this.app) {
            this.app.config = data;
        }

        if (this.workspaceSelect && Array.isArray(data.workspaces)) {
            this.workspaceSelect.innerHTML = '';
            data.workspaces.forEach((ws: string) => {
                const opt = document.createElement('option');
                opt.value = ws;
                opt.innerText = this.formatWorkspaceLabel(ws, data.workspaces);
                opt.title = ws;
                this.workspaceSelect.appendChild(opt);
            });

            let lastChosen: string | null = null;
            try {
                lastChosen = localStorage.getItem(
                    serverKey('phi_last_chosen_project'),
                );
            } catch {
                lastChosen = this.activeWorkspace;
            }
            if (lastChosen && data.workspaces.includes(lastChosen)) {
                this.activeWorkspace = lastChosen;
            } else {
                this.activeWorkspace =
                    data.active_cwd || data.workspaces[0] || '';
            }
            this.workspaceSelect.value = this.activeWorkspace;
            this.updateWorkspaceSelectWidth();
        }

        if (data.theme_color && this.app) {
            // applyAccentTheme sets data-theme-color on <html>;
            // that's what the Settings modal reads on open to
            // pre-select the active swatch.
            (this.app as any).applyAccentTheme?.(data.theme_color);
        }

        if (this.app) {
            // Save the model presets list, quick commands, and terminal commands, then redraw current tab presets.
            this.app.modelPresets = data.model_presets || {};
            this.app.quickCommands = data.quick_commands || [];
            this.app.terminalCommands = data.terminal_commands || [];
            this.app.markdownDirs = data.markdown_dirs || [];
            this.app.useExistingTerminalTab = !!data.use_existing_terminal_tab;
            this.app.useHiddenTerminal = !!data.use_hidden_terminal;
            this.app.applyFastMode?.();
            (this.app as any).ingestAppearance?.(data);
            // Server resolves and clamps the page size; missing/older config
            // falls back to 10. Not part of appearance preferences.
            this.sessionListPageSize =
                Number(data.session_list_page_size) || 10;
            void this.app.loadCustomFont?.();
            void this.app.loadCustomBg?.();
        }

        this.renderCoderTabs?.();
        this.renderQuickLaunchButtons?.();

        const activeTab = this.app?.tabManager?.getActiveTab?.();
        if (activeTab) {
            this.app.tabManager.renderPresets(activeTab.coder);
        }

        if (data.hostname && this.app) {
            this.app.hostname = data.hostname;
            const shown = displayHostname(data.hostname);
            const hostEl = document.getElementById('hostname-display');
            if (hostEl) {
                hostEl.innerText = shown;
            }
            this.app.tabManager?.updateDocumentTitle?.();
            const emptyHostEl = document.getElementById('empty-state-hostname');
            if (emptyHostEl) {
                emptyHostEl.innerText = shown;
            }
        }

        this.updateOpenCodeServiceVisibility?.();
        if (this.app) {
            (this.app as any).settingsReady = true;
            document
                .querySelector('.settings-overlay')
                ?.dispatchEvent(new Event('phi-settings-refresh'));
        }
    }

    async loadConfig(): Promise<void> {
        try {
            await loadCoderRegistry();
            const fetchFn =
                this.app?.scope && typeof this.app.scope.fetch === 'function'
                    ? (url: string, opts?: any) =>
                          this.app.scope.fetch(url, opts)
                    : fetch;
            const res = await fetchFn('/api/config');
            const data = await res.json();
            const store = (this.app as any)?.getActiveStore?.();
            if (store) {
                store.responses.set('/api/config', JSON.stringify(data));
            }
            const applyConfig =
                typeof this.applyConfigData === 'function'
                    ? this.applyConfigData
                    : SessionsManager.prototype.applyConfigData;
            applyConfig.call(this, data, { stale: false });
            await this.app?.loadCustomFont?.();
            await this.app?.loadCustomBg?.();
            await this.loadSessions();
        } catch (e: any) {
            if (e?.name === 'AbortError' || this.app?.scope?.aborted) return;
            console.error('[config] Failed to load workspace config:', e);
        }
    }

    async addWorkspace(path: string): Promise<void> {
        const res = await fetch('/api/config/workspaces', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path }),
        });
        if (!res.ok) {
            const message = await res.text().catch(() => '');
            throw new Error(message.trim() || 'Failed to add workspace.');
        }

        await this.loadConfig();
        this.workspaceSelect.value = path;
        this.activeWorkspace = path;
        this.updateWorkspaceSelectWidth();
        this.loadWorktrees();
    }

    async removeWorkspace(path: string): Promise<void> {
        try {
            const res = await fetch('/api/config/workspaces', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path }),
            });
            if (res.ok) {
                await this.loadConfig();
                this.updateWorkspaceSelectWidth();
            }
        } catch (e) {
            console.error('[config] Failed to remove workspace:', e);
        }
    }

    private setSessionRefreshStatus(message: string): void {
        const status = document.getElementById('session-refresh-status');
        if (status) status.textContent = message;
    }

    private updateRefreshButtonVisibility(): void {
        const button = document.getElementById(
            'refresh-sessions-btn',
        ) as HTMLButtonElement | null;
        if (button) button.hidden = !hasSessions(this.activeCoder);
    }

    private hasSessionDraft(container: ParentNode = this.sessionList): boolean {
        return !!container.querySelector('.rename-input, .args-input-row');
    }

    private cancelSessionRequests(
        predicate: (request: {
            namespace: string;
            profileId: string;
        }) => boolean = () => true,
    ): void {
        for (const request of [
            ...this.sessionRequests.values(),
            ...this.worktreeReads.values(),
        ]) {
            if (predicate(request)) request.cancel('owner');
        }
    }

    private onSessionContextChange(): void {
        this.sessionRefreshGeneration++;
        this.sessionRefreshPromise = null;
        this.cancelSessionRequests();
        this.setSessionRefreshStatus('');
        const button = document.getElementById('refresh-sessions-btn');
        button?.removeAttribute('aria-busy');
    }

    resetSessionRootForBackendSwitch(): void {
        this.onSessionContextChange();
        this.worktreeLoadRequestId++;
        this.worktreeDirtyRequestId++;
        this.worktreeRootGeneration++;
        this.worktreeRootOwner = null;
        this.sessionList.replaceChildren();
    }

    invalidateFeatureCache(profileId: string): void {
        const namespaces = new Set(
            sessionNamespacesByProfile.get(profileId) ?? [],
        );
        const store = (this.app as any)?.getActiveStore?.(profileId);
        let removed = true;
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                const namespace = key ? featureKeyNamespace(key) : null;
                if (namespace?.split(':')[1] === encodeURIComponent(profileId))
                    namespaces.add(namespace);
            }
        } catch {
            removed = false;
        }
        for (const request of [
            ...this.sessionRequests.values(),
            ...this.worktreeReads.values(),
        ]) {
            if (request.profileId === profileId) {
                namespaces.add(request.namespace);
                removeFeatureCache(request.store, request.namespace);
                request.cancel('auth');
            }
        }
        for (const namespace of namespaces) {
            sessionCacheEpochs.set(namespace, sessionCacheEpoch(namespace) + 1);
            recoveredSessionNamespaces.delete(namespace);
            blockedSessionNamespaces.add(namespace);
            if (!removeFeatureCache(store, namespace)) removed = false;
        }
        if (!removed) {
            blockedSessionProfiles.add(profileId);
            this.setSessionRefreshStatus(
                'Saved browser data removal was not confirmed.',
            );
        } else {
            blockedSessionProfiles.delete(profileId);
        }
        sessionNamespacesByProfile.delete(profileId);
    }

    private invalidateSessionNamespace(
        namespace: string,
        store: any,
        except?: HTMLElement,
    ): void {
        sessionCacheEpochs.set(namespace, sessionCacheEpoch(namespace) + 1);
        recoveredSessionNamespaces.delete(namespace);
        blockedSessionNamespaces.add(namespace);
        if (!removeFeatureCache(store, namespace)) {
            unconfirmedSessionRemovals.add(namespace);
            this.setSessionRefreshStatus(
                'Authentication required; saved browser data removal was not confirmed.',
            );
        }
        for (const request of this.worktreeReads.values()) {
            if (request.namespace === namespace) request.cancel('auth');
        }
        for (const [container, request] of this.sessionRequests) {
            if (container !== except && request.namespace === namespace) {
                removeFeatureCache(request.store, namespace);
                request.cancel('auth');
            }
        }
    }

    readCachedWorktrees(store: any, url: string): any[] | null {
        const worktrees = readFeatureCache(
            store,
            sessionCacheIdentity(this.app?.scope, url),
            (value) => normalizeWorktrees(value) !== null,
        );
        return worktrees === null ? null : normalizeWorktrees(worktrees);
    }

    async refreshSessions(): Promise<void> {
        if (this.sessionRefreshPromise) return this.sessionRefreshPromise;
        this.updateRefreshButtonVisibility();
        if (!hasSessions(this.activeCoder)) return;

        const paths = new Set<string>();
        const targets: Array<{
            path: string;
            container: HTMLElement;
            requestId: string | undefined;
        }> = [];
        for (const section of this.sessionList.querySelectorAll<HTMLElement>(
            '.worktree-section',
        )) {
            const path = section.dataset.worktreePath;
            const container = section.querySelector<HTMLElement>(
                '.worktree-sessions-container',
            );
            if (!path || !container || paths.has(path)) continue;
            if (
                !section.classList.contains('expanded') &&
                path !== this.activeCWD
            )
                continue;
            paths.add(path);
            targets.push({
                path,
                container,
                requestId: container.dataset.sessionRequestId,
            });
        }
        if (targets.length === 0) {
            this.setSessionRefreshStatus('No worktree to refresh.');
            return;
        }

        const button = document.getElementById('refresh-sessions-btn');
        const generation = ++this.sessionRefreshGeneration;
        const coder = this.activeCoder;
        const workspace = this.activeWorkspace;
        const scope = this.app?.scope;
        const rootGeneration = this.worktreeRootGeneration;
        const size = this.sessionListPageSize ?? 10;
        const identity = sessionCacheIdentity(
            scope,
            sessionsUrl(coder, this.activeCWD, size),
        );
        const epoch = sessionCacheEpoch(identity?.namespace);
        const isCurrent = () =>
            generation === this.sessionRefreshGeneration &&
            coder === this.activeCoder &&
            workspace === this.activeWorkspace &&
            scope === this.app?.scope &&
            (this.sessionListPageSize ?? 10) === size &&
            rootGeneration === this.worktreeRootGeneration;
        button?.setAttribute('aria-busy', 'true');
        this.setSessionRefreshStatus('Refreshing sessions…');

        const pending = (async () => {
            const results: SessionRequestResult[] = [];
            let next = 0;
            const worker = async () => {
                while (next < targets.length) {
                    const index = next++;
                    const target = targets[index];
                    if (
                        !isCurrent() ||
                        sessionCacheEpoch(identity?.namespace) !== epoch ||
                        !target.container.isConnected ||
                        target.container.dataset.sessionRequestId !==
                            target.requestId
                    ) {
                        results[index] = 'superseded';
                        continue;
                    }
                    results[index] = await this.loadWorktreeSessions(
                        target.path,
                        target.container,
                        0,
                        { refresh: true },
                    );
                }
            };
            await Promise.all(
                Array.from({ length: Math.min(4, targets.length) }, worker),
            );
            if (!isCurrent()) return;
            const count = (result: SessionRequestResult) =>
                results.filter((value) => value === result).length;
            const updated = count('updated');
            const failed = count('failed');
            const editing = count('editing');
            const changed = count('superseded');
            if (identity && blockedSessionNamespaces.has(identity.namespace)) {
                this.setSessionRefreshStatus(
                    unconfirmedSessionRemovals.has(identity.namespace)
                        ? 'Authentication required; saved browser data removal was not confirmed.'
                        : 'Authentication is required to refresh sessions.',
                );
            } else if (updated === targets.length) {
                this.setSessionRefreshStatus('Sessions refreshed.');
            } else if (editing === targets.length) {
                this.setSessionRefreshStatus(
                    'Finish or cancel the edit, then refresh.',
                );
            } else if (failed === targets.length) {
                this.setSessionRefreshStatus(
                    'Refresh failed. Showing the last saved list.',
                );
            } else if (changed === targets.length) {
                this.setSessionRefreshStatus(
                    'Refresh interrupted by navigation.',
                );
            } else {
                this.setSessionRefreshStatus(
                    `${updated} refreshed; ${failed} failed; ${editing} editing; ${changed} changed.`,
                );
            }
        })().finally(() => {
            if (this.sessionRefreshPromise === pending) {
                this.sessionRefreshPromise = null;
                button?.removeAttribute('aria-busy');
            }
        });
        this.sessionRefreshPromise = pending;
        return pending;
    }

    private markSessionListSaved(container: HTMLElement): void {
        const note = document.createElement('div');
        note.className = 'session-refresh-status session-cache-note';
        note.textContent = 'Saved list. May be out of date.';
        container.appendChild(note);
    }

    async loadSessions(): Promise<void> {
        await this.loadWorktrees();
    }

    switchCoder(coderId: string, skipReload: boolean = false): void {
        // Pseudo-coders / reserved IDs cannot become the sidebar's
        // active coder — they don't own a sessions list. The same
        // guard existed before the registry refactor; the names now
        // come from the reserved-ID set so a future reserved ID
        // (e.g. an internal future coder) inherits the same rule.
        if (RESERVED_CODER_IDS.has(coderId)) return;
        if (this.activeCoder === coderId) return;
        this.onSessionContextChange();
        this.activeCoder = coderId;
        this.updateRefreshButtonVisibility();

        document.querySelectorAll('.coder-tab').forEach((tab) => {
            if (tab.getAttribute('data-coder') === coderId) {
                tab.classList.add('active');
            } else {
                tab.classList.remove('active');
            }
        });

        if (!skipReload) {
            this.loadSessions();
        }
        this.updateOpenCodeServiceVisibility();

        // The Ctrl+Shift+X chip is rendered inside the presets-container row
        // by renderPresets() based on the *active tab's* coder, so it appears
        // exactly when the user is in a pi session — not just when the sidebar
        // coder-tab is set to pi. The keybinding itself remains global.
    }

    highlightActiveWorktree(cwdPath: string): void {
        if (!cwdPath) return;
        document.querySelectorAll('.worktree-section').forEach((sec) => {
            const secPath = sec.getAttribute('data-worktree-path');
            if (normalizePath(secPath!) === normalizePath(cwdPath)) {
                sec.classList.add('active');
                sec.classList.add('expanded');
                const container = sec.querySelector(
                    '.worktree-sessions-container',
                );
                if (
                    container &&
                    (container.innerHTML === '' ||
                        container.innerHTML.includes('Scanning sessions...'))
                ) {
                    this.loadWorktreeSessions(
                        secPath!,
                        container as HTMLElement,
                    );
                }
            } else {
                sec.classList.remove('active');
                sec.classList.remove('expanded');
            }
        });
    }

    private captureSessionListSnapshot(): SessionListSnapshot {
        const snapshot: SessionListSnapshot = { sections: new Map() };
        const active = document.activeElement as HTMLElement | null;
        for (const section of this.sessionList.querySelectorAll<HTMLElement>(
            '.worktree-section',
        )) {
            const path = section.dataset.worktreePath;
            const container = section.querySelector<HTMLElement>(
                '.worktree-sessions-container',
            );
            if (!path || !container) continue;
            const offset = Number(container.dataset.sessionOffset ?? 0);
            snapshot.sections.set(path, {
                expanded: section.classList.contains('expanded'),
                offset:
                    Number.isSafeInteger(offset) && offset >= 0 ? offset : 0,
            });
            if (
                active?.matches('.session-page') &&
                container.contains(active) &&
                active.dataset.page
            ) {
                snapshot.focus = { path, delta: active.dataset.page };
            }
        }
        return snapshot;
    }

    private paintWorktreeSessionPage(
        path: string,
        container: HTMLElement,
        offset: number,
        revalidate: boolean,
    ): void {
        if (revalidate) {
            void this.loadWorktreeSessions(path, container, offset);
            return;
        }
        const size = this.sessionListPageSize ?? 10;
        const cached = readCachedSessions(
            (this.app as any)?.getActiveStore?.(),
            this.app?.scope,
            sessionsUrl(this.activeCoder, path, size, offset),
            size,
        );
        if (cached) {
            this.renderWorktreeSessionsList(cached, path, container, offset);
            this.markSessionListSaved(container);
            if (
                container.dataset.sessionRestoreFocus &&
                document.activeElement === document.body
            ) {
                focusPagerButton(
                    container,
                    container.dataset.sessionRestoreFocus,
                );
                delete container.dataset.sessionRestoreFocus;
            }
        } else {
            container.innerHTML =
                '<div class="no-sessions-found">No saved session list yet.</div>';
        }
    }

    private async readWorktreeResponse(
        kind: 'list' | 'dirty',
        url: string,
        scope: any,
        isCurrent: () => boolean,
        identity: SessionCacheIdentity | null,
        store: any,
    ): Promise<any> {
        if (scope?.signal?.aborted || scope?.aborted || !isCurrent())
            throw new DOMException('Owner changed', 'AbortError');
        this.worktreeReads.get(kind)?.cancel('owner');
        const controller = new AbortController();
        let rejectCancel!: (error: Error) => void;
        const cancelled = new Promise<never>((_resolve, reject) => {
            rejectCancel = reject;
        });
        let settled = false;
        const cancel = (reason: 'owner' | 'timeout' | 'auth') => {
            if (settled) return;
            controller.abort();
            rejectCancel(
                reason === 'timeout'
                    ? new Error('Worktree refresh timed out')
                    : new DOMException('Owner changed', 'AbortError'),
            );
        };
        const request = {
            cancel,
            namespace: identity?.namespace ?? '',
            profileId: scope?.profileId ?? getEmbeddedProfileId(),
            store,
        };
        this.worktreeReads.set(kind, request);
        const scopeAbort = () => cancel('owner');
        scope?.signal?.addEventListener('abort', scopeAbort, { once: true });
        const timer = setTimeout(
            () => cancel('timeout'),
            SESSION_REQUEST_TIMEOUT_MS,
        );
        try {
            const operation = (async () => {
                const response = await fetch(url, {
                    headers:
                        scope?.headers?.() ??
                        (request.profileId
                            ? { 'X-Phi-Backend': request.profileId }
                            : {}),
                    credentials: 'same-origin',
                    cache: 'no-store',
                    signal: controller.signal,
                });
                if (controller.signal.aborted || !isCurrent())
                    throw new DOMException('Owner changed', 'AbortError');
                if (response.status === 401 || response.status === 403) {
                    this.setSessionRefreshStatus(
                        'Authentication is required to refresh sessions.',
                    );
                    if (identity)
                        this.invalidateSessionNamespace(
                            identity.namespace,
                            store,
                        );
                    throw new DOMException(
                        'Authentication required',
                        'AbortError',
                    );
                }
                if (!response.ok)
                    throw new Error(
                        kind === 'list'
                            ? 'Failed to scan worktrees'
                            : 'Failed to load worktree dirty state',
                    );
                return await response.json();
            })();
            return await Promise.race([operation, cancelled]);
        } finally {
            settled = true;
            clearTimeout(timer);
            scope?.signal?.removeEventListener('abort', scopeAbort);
            if (this.worktreeReads.get(kind) === request)
                this.worktreeReads.delete(kind);
        }
    }

    async loadWorktrees(targetCwd: string | null = null): Promise<void> {
        const requestId = ++this.worktreeLoadRequestId;
        const workspace = this.activeWorkspace;
        const coder = this.activeCoder;
        const scope = this.app?.scope;
        const store = (this.app as any)?.getActiveStore?.();
        let startingCwd = this.activeCWD;
        const url = `/api/git/worktrees?cwd=${encodeURIComponent(workspace)}`;
        const identity = sessionCacheIdentity(scope, url);
        const epoch = sessionCacheEpoch(identity?.namespace);
        let sameOwner =
            this.worktreeRootOwner?.scope === scope &&
            this.worktreeRootOwner?.coder === coder &&
            this.worktreeRootOwner?.workspace === workspace;
        if (
            scope?.signal?.aborted ||
            scope?.aborted ||
            (sameOwner && this.hasSessionDraft())
        )
            return;
        if (!sameOwner) {
            this.worktreeRootGeneration++;
            this.onSessionContextChange();
            this.worktreeRootOwner = { scope, coder, workspace };
            const cached = this.readCachedWorktrees(store, url);
            if (cached) {
                this.renderWorktreesList(cached, workspace, targetCwd, {
                    loadSessions: false,
                    startingCwd,
                });
                startingCwd = this.activeCWD;
                sameOwner = true;
            } else {
                this.sessionList.innerHTML =
                    '<div class="no-sessions-found">No saved worktree list yet.</div><div class="scanning-sessions">Scanning git worktrees...</div>';
            }
        }
        const rootGeneration = this.worktreeRootGeneration;
        const isCurrentRequest = () =>
            requestId === this.worktreeLoadRequestId &&
            workspace === this.activeWorkspace &&
            coder === this.activeCoder &&
            scope === this.app?.scope &&
            rootGeneration === this.worktreeRootGeneration &&
            epoch === sessionCacheEpoch(identity?.namespace);
        try {
            const parsed = await this.readWorktreeResponse(
                'list',
                url,
                scope,
                isCurrentRequest,
                identity,
                store,
            );
            if (!isCurrentRequest()) return;
            const worktrees = normalizeWorktrees(parsed);
            if (!worktrees) throw new Error('Invalid worktree response');
            if (identity) recoverSessionNamespace(identity);
            writeFeatureCache(
                store,
                identity,
                worktrees,
                (value) => normalizeWorktrees(value) !== null,
                () => {
                    if (
                        requestId === this.worktreeLoadRequestId &&
                        scope === this.app?.scope &&
                        coder === this.activeCoder &&
                        workspace === this.activeWorkspace
                    ) {
                        this.setSessionRefreshStatus(
                            'Browser storage unavailable. Lists are kept in this tab only.',
                        );
                    }
                },
            );
            if (sameOwner && this.hasSessionDraft()) return;
            const snapshot = sameOwner
                ? this.captureSessionListSnapshot()
                : undefined;
            const sections = Array.from(
                this.sessionList.querySelectorAll<HTMLElement>(
                    '.worktree-section:not(.no-workspace-section)',
                ),
            );
            const structureUnchanged =
                sameOwner &&
                !targetCwd &&
                worktrees.length > 0 &&
                sections.length === worktrees.length &&
                worktrees.every(
                    (wt, i) =>
                        sections[i].dataset.worktreePath === wt.path &&
                        (sections[i].dataset.worktreeBranch ?? '') ===
                            (wt.branch ?? '') &&
                        sections[i].classList.contains('active') ===
                            (normalizePath(wt.path) ===
                                normalizePath(this.activeCWD)),
                ) &&
                worktrees.some(
                    (wt) =>
                        normalizePath(wt.path) ===
                        normalizePath(this.activeCWD),
                );
            if (structureUnchanged) {
                this.sessionList
                    .querySelector(':scope > .error-sessions')
                    ?.remove();
                for (const section of this.sessionList.querySelectorAll<HTMLElement>(
                    '.worktree-section.expanded',
                )) {
                    const path = section.dataset.worktreePath!;
                    const container = section.querySelector<HTMLElement>(
                        '.worktree-sessions-container',
                    )!;
                    this.paintWorktreeSessionPage(
                        path,
                        container,
                        snapshot?.sections.get(path)?.offset ?? 0,
                        true,
                    );
                }
                void this.loadWorktreeDirtyStates(
                    workspace,
                    ++this.worktreeDirtyRequestId,
                );
                return;
            }
            this.renderWorktreesList(worktrees, workspace, targetCwd, {
                loadSessions: true,
                startingCwd,
                snapshot,
            });
        } catch (error: any) {
            if (error?.name === 'AbortError' || !isCurrentRequest()) return;
            this.sessionList
                .querySelector(':scope > .error-sessions')
                ?.remove();
            this.sessionList
                .querySelector(':scope > .scanning-sessions')
                ?.remove();
            const note = document.createElement('div');
            note.className = 'error-sessions';
            note.textContent = `Error scanning worktrees: ${(error as Error).message}`;
            this.sessionList.appendChild(note);
        }
    }

    renderWorktreesList(
        worktrees: any[],
        workspace: string,
        targetCwd: string | null = null,
        {
            loadSessions = true,
            startingCwd,
            snapshot,
        }: {
            loadSessions?: boolean;
            startingCwd?: string;
            snapshot?: SessionListSnapshot;
        } = {},
    ): void {
        if (
            this.worktreeRootOwner?.scope === this.app?.scope &&
            this.worktreeRootOwner?.coder === this.activeCoder &&
            this.worktreeRootOwner?.workspace === workspace &&
            this.hasSessionDraft()
        )
            return;
        this.worktreeRootGeneration++;
        this.worktreeDirtyRequestId++;
        this.onSessionContextChange();
        this.worktreeRootOwner = {
            scope: this.app?.scope,
            coder: this.activeCoder,
            workspace,
        };
        this.sessionList.innerHTML = '';

        if (!worktrees || worktrees.length === 0) {
            this.sessionList.innerHTML =
                '<div style="padding: 16px; color: var(--text-muted); font-size: 13px; text-align: center;">No worktrees found</div>';
            return;
        }

        const baselineCwd =
            startingCwd !== undefined ? startingCwd : this.activeCWD;
        if (startingCwd === undefined || this.activeCWD === startingCwd) {
            if (targetCwd) {
                this.activeCWD = targetCwd;
            } else {
                const hasCwd = worktrees.some(
                    (wt: any) =>
                        normalizePath(wt.path) === normalizePath(baselineCwd),
                );
                if (!hasCwd) {
                    const activeWT = worktrees.find((wt: any) => wt.active);
                    if (activeWT) {
                        this.activeCWD = activeWT.path;
                    } else {
                        this.activeCWD = worktrees[0].path;
                    }
                }
            }
        }

        try {
            localStorage.setItem(
                serverKey('phi_last_chosen_project'),
                workspace,
            );
        } catch {
            /* Rendering must work without storage. */
        }

        // Append a faint "-- No workspace --" section for sessions with no cwd.
        // Only relevant for agy (others don't have unworkspaced sessions).
        // Rendered after real worktrees, collapsed by default.
        const appendNoWorkspaceSection = () => {
            if (this.activeCoder !== 'agy') return;
            const nwSection = document.createElement('div');
            nwSection.className = 'worktree-section no-workspace-section';
            nwSection.setAttribute('data-worktree-path', '--no-workspace--');
            nwSection.innerHTML = `
                <div class="worktree-header">
                    <svg class="icon chevron-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="9 18 15 12 9 6"></polyline>
                    </svg>
                    <span class="worktree-name">— no workspace —</span>
                </div>
                <div class="worktree-sessions-container"></div>
            `;
            const header = nwSection.querySelector(
                '.worktree-header',
            ) as HTMLElement;
            header.addEventListener('click', async () => {
                const isExpanded = nwSection.classList.toggle('expanded');
                if (isExpanded) {
                    await this.loadWorktreeSessions(
                        '--no-workspace--',
                        nwSection.querySelector(
                            '.worktree-sessions-container',
                        )!,
                    );
                }
            });
            this.sessionList.appendChild(nwSection);
            const saved = snapshot?.sections.get('--no-workspace--');
            if (saved?.expanded) nwSection.classList.add('expanded');
            const container = nwSection.querySelector<HTMLElement>(
                '.worktree-sessions-container',
            )!;
            if (snapshot?.focus?.path === '--no-workspace--')
                container.dataset.sessionRestoreFocus = snapshot.focus.delta;
            if (saved)
                this.paintWorktreeSessionPage(
                    '--no-workspace--',
                    container,
                    saved.offset,
                    loadSessions && saved.expanded,
                );
        };

        worktrees.forEach((wt: any) => {
            const wtSection = document.createElement('div');
            wtSection.className = 'worktree-section';
            wtSection.setAttribute('data-worktree-path', wt.path);
            wtSection.dataset.worktreeBranch = wt.branch ?? '';
            const saved = snapshot?.sections.get(wt.path);

            const isCurrentCWD =
                normalizePath(wt.path) === normalizePath(this.activeCWD);
            const expanded = saved?.expanded ?? !!(wt.expanded || isCurrentCWD);
            if (expanded) {
                wtSection.classList.add('expanded');
            }
            if (isCurrentCWD) {
                wtSection.classList.add('active');
            }

            const parts = wt.path.split(/[/\\]/);
            const baseName = parts[parts.length - 1] || wt.path;
            const wtGlyph = worktreeGlyph(wt.path);

            let hasLiveTab = false;
            if (this.app?.tabManager?.tabs) {
                const wtPathNorm = normalizePath(wt.path);
                for (const t of this.app.tabManager.tabs.values()) {
                    if (t.cwd && normalizePath(t.cwd) === wtPathNorm) {
                        hasLiveTab = true;
                        break;
                    }
                }
            }
            if (hasLiveTab) {
                wtSection.classList.add('has-live-tab');
            }

            wtSection.innerHTML = `
                <div class="worktree-header">
                    <svg class="icon chevron-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="9 18 15 12 9 6"></polyline>
                    </svg>
                    <span class="worktree-glyph-cell"><span class="worktree-section-glyph" aria-hidden="true" title="${escapeHtml(wt.path)}">${wtGlyph}</span></span>
                    <span class="worktree-name" title="${escapeHtml(wt.path)}">${escapeHtml(baseName)}</span>
                    ${wt.branch ? `<span class="worktree-branch">[${escapeHtml(wt.branch)}]</span>` : ''}
                    <span class="worktree-dirty-indicator hidden" title="Unstaged changes" aria-hidden="true">★</span>
                </div>
                <div class="worktree-sessions-container">
                    <div class="scanning-sessions">Scanning sessions...</div>
                </div>
            `;

            const header = wtSection.querySelector(
                '.worktree-header',
            ) as HTMLElement;
            header.addEventListener('click', async (e) => {
                e.stopPropagation();
                const isExpanded = wtSection.classList.toggle('expanded');

                document
                    .querySelectorAll('.worktree-section')
                    .forEach((sec) => {
                        sec.classList.remove('active');
                        if (sec !== wtSection) {
                            sec.classList.remove('expanded');
                        }
                    });

                wtSection.classList.add('active');
                this.activeCWD = wt.path;

                this.app.diffController.refreshDiff();

                const activeTab = this.app.tabManager.getActiveTab();
                if (activeTab && activeTab.coder === this.activeCoder) {
                    this.highlightActiveSession(activeTab.sessionId);
                }

                void this.saveWorktreeState();

                if (isExpanded) {
                    void this.loadWorktreeSessions(
                        wt.path,
                        wtSection.querySelector(
                            '.worktree-sessions-container',
                        )!,
                    );
                }
            });

            this.sessionList.appendChild(wtSection);

            const container = wtSection.querySelector<HTMLElement>(
                '.worktree-sessions-container',
            )!;
            if (snapshot?.focus && snapshot.focus.path === wt.path)
                container.dataset.sessionRestoreFocus = snapshot.focus.delta;
            if (expanded || saved)
                this.paintWorktreeSessionPage(
                    wt.path,
                    container,
                    saved?.offset ?? 0,
                    loadSessions && expanded,
                );
        });

        appendNoWorkspaceSection();
        if (loadSessions) {
            this.loadWorktreeDirtyStates(
                workspace,
                this.worktreeDirtyRequestId,
            );
        }
    }

    async loadWorktreeDirtyStates(
        workspace: string,
        requestId: number,
    ): Promise<void> {
        const scope = this.app?.scope;
        const coder = this.activeCoder;
        const rootGeneration = this.worktreeRootGeneration;
        const url = `/api/git/worktree-dirty?cwd=${encodeURIComponent(workspace)}`;
        const identity = sessionCacheIdentity(scope, url);
        const epoch = sessionCacheEpoch(identity?.namespace);
        const current = () =>
            requestId === this.worktreeDirtyRequestId &&
            workspace === this.activeWorkspace &&
            scope === this.app?.scope &&
            coder === this.activeCoder &&
            rootGeneration === this.worktreeRootGeneration &&
            epoch === sessionCacheEpoch(identity?.namespace);
        try {
            const dirtyStates = await this.readWorktreeResponse(
                'dirty',
                url,
                scope,
                current,
                identity,
                (this.app as any)?.getActiveStore?.(),
            );
            if (!current()) return;
            if (
                !dirtyStates ||
                typeof dirtyStates !== 'object' ||
                Array.isArray(dirtyStates)
            )
                throw new Error('Invalid worktree dirty state');

            this.sessionList
                .querySelectorAll('.worktree-section')
                .forEach((section) => {
                    const path = section.getAttribute('data-worktree-path');
                    if (!path || path === '--no-workspace--') return;

                    const indicator = section.querySelector(
                        '.worktree-dirty-indicator',
                    );
                    if (!indicator) return;

                    if (dirtyStates[path]) {
                        indicator.classList.remove('hidden');
                    } else {
                        indicator.classList.add('hidden');
                    }
                });
        } catch (error: any) {
            if (error?.name !== 'AbortError' && current())
                this.setSessionRefreshStatus(
                    'Worktree status could not be refreshed.',
                );
        }
    }

    async loadWorktreeSessions(
        wtPath: string,
        container: HTMLElement,
        offset = 0,
        { refresh = false }: { refresh?: boolean } = {},
    ): Promise<SessionRequestResult> {
        const size = this.sessionListPageSize ?? 10;
        const coder = this.activeCoder;
        const workspace = this.activeWorkspace;
        const scope = this.app?.scope;
        const store = (this.app as any)?.getActiveStore?.();
        const url = sessionsUrl(coder, wtPath, size, offset);
        const identity = sessionCacheIdentity(scope, url);
        const namespace = identity?.namespace ?? '';
        const epoch = sessionCacheEpoch(identity?.namespace);
        const rootGeneration = this.worktreeRootGeneration;
        const currentRoot = this.worktreeRootOwner;
        const ownsRoot = () =>
            !currentRoot ||
            (currentRoot.scope === scope &&
                currentRoot.coder === coder &&
                currentRoot.workspace === workspace);

        if (scope?.aborted || !ownsRoot()) return 'superseded';
        if (refresh && this.hasSessionDraft(container)) return 'editing';

        const previous = this.sessionRequests.get(container);
        if (
            !refresh &&
            previous &&
            previous.offset === offset &&
            container.dataset.sessionPendingOffset === String(offset)
        ) {
            return 'superseded';
        }
        previous?.cancel('owner');

        const requestId = String(
            Number(container.dataset.sessionRequestId ?? 0) + 1,
        );
        container.dataset.sessionRequestId = requestId;
        container.dataset.sessionPendingOffset = String(offset);
        const isCurrentRequest = () =>
            container.dataset.sessionRequestId === requestId &&
            this.activeCoder === coder &&
            this.activeWorkspace === workspace &&
            this.app?.scope === scope &&
            this.worktreeRootGeneration === rootGeneration &&
            (this.sessionListPageSize ?? 10) === size &&
            ownsRoot() &&
            container.isConnected &&
            sessionCacheEpoch(identity?.namespace) === epoch;

        const focusedPagerPage = () => {
            const active = document.activeElement;
            return active instanceof HTMLElement &&
                active.classList.contains('session-page') &&
                container.contains(active)
                ? active.dataset.page
                : undefined;
        };
        const renderPage = (sessions: any[]) => {
            if (!isCurrentRequest() || this.hasSessionDraft(container))
                return false;
            const focusedPage =
                focusedPagerPage() ??
                (document.activeElement === document.body
                    ? container.dataset.sessionRestoreFocus
                    : undefined);
            delete container.dataset.sessionRestoreFocus;
            const renderSessions =
                typeof this.renderWorktreeSessionsList === 'function'
                    ? this.renderWorktreeSessionsList
                    : SessionsManager.prototype.renderWorktreeSessionsList;
            renderSessions.call(this, sessions, wtPath, container, offset);
            if (focusedPage) focusPagerButton(container, focusedPage);
            return true;
        };

        const cached = refresh
            ? null
            : readCachedSessions(store, scope, url, size);
        if (cached && !this.hasSessionDraft(container)) {
            try {
                if (renderPage(cached)) this.markSessionListSaved(container);
            } catch {
                if (identity) store?.responses?.delete?.(identity.key);
            }
        }
        if (
            !cached &&
            !container.querySelector('.session-item, .no-sessions-found') &&
            !this.hasSessionDraft(container)
        ) {
            container.innerHTML =
                '<div class="no-sessions-found">No saved session list yet.</div>' +
                (refresh
                    ? ''
                    : '<div class="scanning-sessions">Scanning sessions...</div>');
        }

        const controller = new AbortController();
        let rejectCancel!: (error: Error & { kind?: string }) => void;
        const cancelled = new Promise<never>((_resolve, reject) => {
            rejectCancel = reject;
        });
        void cancelled.catch(() => {});
        let settled = false;
        const cancel = (kind: 'owner' | 'timeout' | 'auth') => {
            if (settled) return;
            controller.abort();
            const error = new DOMException(
                kind === 'timeout'
                    ? 'Session refresh timed out'
                    : 'Session request superseded',
                'AbortError',
            ) as Error & { kind?: string };
            error.kind = kind;
            rejectCancel(error);
        };
        const request = {
            controller,
            cancel,
            namespace,
            profileId: scope?.profileId ?? getEmbeddedProfileId(),
            requestId,
            offset,
            store,
        };
        this.sessionRequests.set(container, request);
        const scopeAbort = () => cancel('owner');
        if (scope?.signal?.aborted) {
            cancel('owner');
        } else {
            scope?.signal?.addEventListener('abort', scopeAbort, {
                once: true,
            });
        }
        const timeout = setTimeout(
            () => cancel('timeout'),
            SESSION_REQUEST_TIMEOUT_MS,
        );
        const headers =
            typeof scope?.headers === 'function'
                ? scope.headers()
                : request.profileId
                  ? { 'X-Phi-Backend': request.profileId }
                  : {};

        try {
            if (scope?.signal?.aborted) return 'superseded';
            const operation = (async () => {
                const response = await fetch(url, {
                    headers,
                    cache: 'no-store',
                    credentials: 'same-origin',
                    signal: controller.signal,
                });
                if (controller.signal.aborted || !isCurrentRequest())
                    throw new DOMException('Owner changed', 'AbortError');
                if (response.status === 401 || response.status === 403) {
                    this.setSessionRefreshStatus(
                        'Authentication is required to refresh sessions.',
                    );
                    if (identity) {
                        this.invalidateSessionNamespace(
                            identity.namespace,
                            store,
                            container,
                        );
                    }
                    const error = new Error(
                        'Authentication required',
                    ) as Error & {
                        sessionAuth?: boolean;
                    };
                    error.sessionAuth = true;
                    throw error;
                }
                if (!response.ok) {
                    const detail = await response.text();
                    throw new Error(
                        detail ||
                            `Session request failed (HTTP ${response.status})`,
                    );
                }
                const sessions = await response.json();
                if (!isSessionPage(sessions, size)) {
                    throw new Error('Invalid session response');
                }
                return sessions;
            })();
            const sessions = await Promise.race([operation, cancelled]);
            if (!isCurrentRequest()) return 'superseded';
            if (identity) recoverSessionNamespace(identity);
            writeFeatureCache(
                store,
                identity,
                sessions,
                (value) => isSessionPage(value, size),
                () => {
                    if (isCurrentRequest())
                        this.setSessionRefreshStatus(
                            'Browser storage unavailable. Lists are kept in this tab only.',
                        );
                },
            );
            if (this.hasSessionDraft(container)) return 'editing';
            return renderPage(sessions) ? 'updated' : 'editing';
        } catch (error: any) {
            if (error?.sessionAuth) return 'failed';
            if (
                error?.kind === 'owner' ||
                (error?.name === 'AbortError' && error?.kind !== 'timeout')
            ) {
                return 'superseded';
            }
            if (!isCurrentRequest()) return 'superseded';
            if (this.hasSessionDraft(container)) return 'editing';

            const message = `Error: ${(error as Error).message}`;
            container.querySelector('.error-sessions')?.remove();
            const errorNote = document.createElement('div');
            errorNote.className = 'error-sessions';
            errorNote.textContent = message;
            if (container.querySelector('.session-item, .no-sessions-found')) {
                container.appendChild(errorNote);
            } else {
                container.replaceChildren();
                const empty = document.createElement('div');
                empty.className = 'no-sessions-found';
                empty.textContent = 'No saved session list yet.';
                container.append(empty, errorNote);
            }
            return 'failed';
        } finally {
            settled = true;
            clearTimeout(timeout);
            scope?.signal?.removeEventListener('abort', scopeAbort);
            if (this.sessionRequests.get(container) === request) {
                this.sessionRequests.delete(container);
            }
            if (container.dataset.sessionRequestId === requestId) {
                delete container.dataset.sessionPendingOffset;
            }
        }
    }

    renderWorktreeSessionsList(
        sessions: any[],
        wtPath: string,
        container: HTMLElement,
        offset = 0,
    ): void {
        container.dataset.sessionOffset = String(offset);
        container.innerHTML = '';
        const rows = Array.isArray(sessions) ? sessions : [];
        if (rows.length === 0) {
            container.innerHTML =
                '<div class="no-sessions-found">No sessions found</div>';
        }

        rows.forEach((sess: any) => {
            const item = document.createElement('div');
            item.className = 'session-item';
            item.setAttribute('data-session-id', sess.id);
            item.setAttribute('data-worktree-path', wtPath);

            const timeStr = new Date(sess.time_updated).toLocaleDateString(
                undefined,
                {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                },
            );

            let isRunning = false;
            let isIdleAlive = false;
            for (const t of this.app.tabManager.tabs.values()) {
                if (
                    t.sessionId === sess.id &&
                    t.coder === this.activeCoder &&
                    !t.isDead
                ) {
                    // btop redraws the whole screen multiple times per
                    // second; its isBusy stays true forever. Skip it so
                    // the ankh/djed glyph doesn't pin on the row.
                    if (t.isBusy && !t.isBtop) {
                        isRunning = true;
                    } else {
                        // Tab exists and is alive, but the watcher
                        // is just monitoring it (not generating
                        // output). Eye of Horus = "being watched."
                        isIdleAlive = true;
                    }
                    break;
                }
            }

            // Three glyph states for a live session row:
            //   ☥  ankh     — actively running, recent (< 2 min)
            //   𓊽  djed    — running, stable (> 2 min)
            //   𓂀  eye     — alive but idle, watcher is monitoring
            //                   (no current output, tab still open)
            // No glyph when there's no live tab at all.
            let statusGlyph = '';
            let statusClass = '';
            if (isRunning) {
                const ageMs =
                    Date.now() - new Date(sess.time_updated).getTime();
                const isStable = ageMs > 2 * 60 * 1000;
                statusGlyph = isStable ? '𓊽' : '☥';
                if (isStable) statusClass = 'stable';
            } else if (isIdleAlive) {
                statusGlyph = '𓂀';
                statusClass = 'idle';
            }

            item.innerHTML = `
                    <div class="session-meta-top">
                        <span class="session-title"></span>
                        ${statusGlyph ? `<span class="session-dot ${statusClass}"></span>` : ''}
                    </div>
                    <span class="session-time">${timeStr}</span>
                    <div class="session-actions">
                        ${
                            hasTranscript(this.activeCoder) ||
                            hasPiRpc(this.activeCoder)
                                ? `
                        <button class="session-action-btn review-btn" title="${hasPiRpc(this.activeCoder) ? 'Open Pi RPC' : 'Review Transcript'}" aria-label="${hasPiRpc(this.activeCoder) ? 'Open Pi RPC' : 'Review Transcript'}">
                            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
                        </button>
                        `
                                : ''
                        }
                        ${
                            hasRename(this.activeCoder)
                                ? `
                        <button class="session-action-btn rename-btn" title="Rename Session">
                            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
                        </button>
                        `
                                : ''
                        }
                    </div>
                `;
            // Safe rendering for the title (R9): the server
            // returns arbitrary session titles that include
            // user-supplied text. textContent escapes HTML
            // automatically; innerHTML would not.
            const titleEl = item.querySelector('.session-title');
            if (titleEl) titleEl.textContent = sess.title;
            const dotEl = item.querySelector('.session-dot');
            if (dotEl && statusGlyph) dotEl.textContent = statusGlyph;

            if (sess.coder === 'pi' && this.activeCoder !== 'pi') {
                const link = document.createElement('a');
                link.href = '#';
                link.className = 'session-action-btn';
                link.textContent = 'Pi chat';
                link.addEventListener('click', (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    openPiRpcChatTab(
                        this.app.tabManager,
                        sess.cwd ?? '',
                        sess.session_path,
                        sess.title,
                    );
                });
                item.querySelector('.session-actions')?.appendChild(link);
            }

            item.addEventListener('click', (e) => {
                if ((e.target as Element).closest('.session-action-btn'))
                    return;
                this.launchSession(sess.id, sess.title);

                const sidebar = document.getElementById('sidebar-panel');
                if (sidebar) {
                    sidebar.classList.remove('drawer-open');
                }
            });

            item.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this._showSessionContextMenu(e, item, sess);
            });

            if (hasTranscript(this.activeCoder) || hasPiRpc(this.activeCoder)) {
                const reviewBtn = item.querySelector('.review-btn');
                if (reviewBtn) {
                    reviewBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        // PiRpc capability wins when both are
                        // advertised — Pi has both today (the
                        // chat surface is preferred over the
                        // legacy transcript view). Future
                        // backends with both can flip the order.
                        if (hasPiRpc(this.activeCoder)) {
                            openPiRpcChatTab(
                                this.app.tabManager,
                                sess.cwd ?? wtPath,
                                sess.session_path,
                                sess.title,
                            );
                        } else {
                            this.openReviewTab(sess);
                        }
                        const sidebar =
                            document.getElementById('sidebar-panel');
                        if (sidebar) {
                            sidebar.classList.remove('drawer-open');
                        }
                    });
                }
            }

            if (hasRename(this.activeCoder)) {
                const renameBtn = item.querySelector('.rename-btn');
                if (renameBtn) {
                    renameBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.openInlineRenamer(item, sess.id, sess.title);
                    });
                }
            }

            container.appendChild(item);
        });

        this.renderSessionPager(container, wtPath, offset, rows.length);

        const activeTab = this.app?.tabManager?.getActiveTab?.();
        if (activeTab && activeTab.coder === this.activeCoder) {
            this.highlightActiveSession(activeTab.sessionId);
        }
    }

    renderSessionPager(
        container: HTMLElement,
        wtPath: string,
        offset: number,
        rowCount: number,
    ): void {
        const size = this.sessionListPageSize ?? 10;
        const hasPrev = offset > 0;
        const hasNext = rowCount === size;
        if (!hasPrev && !hasNext) return;

        const pager = document.createElement('div');
        pager.className = 'session-pager';
        const pageButton = (delta: -1 | 1, text: string) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'btn btn-primary session-page';
            button.dataset.page = String(delta);
            button.textContent = text;
            button.disabled = delta < 0 ? !hasPrev : !hasNext;
            button.setAttribute(
                'aria-label',
                delta < 0 ? 'Previous page' : 'Next page',
            );
            button.addEventListener('click', (event) => {
                // Cached painting removes this button before the outside-click handler runs.
                event.stopPropagation();
                void this.loadWorktreeSessions(
                    wtPath,
                    container,
                    offset + delta * size,
                );
            });
            return button;
        };
        const label = document.createElement('span');
        label.className = 'session-page-label';
        label.textContent = `Page ${Math.floor(offset / size) + 1}`;
        pager.append(pageButton(-1, '\u2039'), label, pageButton(1, '\u203a'));
        container.appendChild(pager);
    }

    async saveWorktreeState(): Promise<void> {
        const expandedStates: Record<string, boolean> = {};
        document.querySelectorAll('.worktree-section').forEach((sec) => {
            const path = sec.getAttribute('data-worktree-path');
            expandedStates[path!] = sec.classList.contains('expanded');
        });

        try {
            await fetch('/api/config/worktree-state', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    workspace: this.activeWorkspace,
                    active_worktree: this.activeCWD,
                    expanded: expandedStates,
                }),
            });
        } catch (e) {
            console.error('[worktree-state] Failed to save worktree state:', e);
        }
    }

    highlightActiveSession(sessionId: string): void {
        document.querySelectorAll('.session-item').forEach((item) => {
            if (item.getAttribute('data-session-id') === sessionId) {
                item.classList.add('active');
            } else {
                item.classList.remove('active');
            }
        });
    }

    async spawnNewSession(mini: boolean = false): Promise<void> {
        try {
            if (isCompactViewport()) {
                document
                    .getElementById('sidebar-panel')
                    ?.classList.remove('drawer-open');
            }
            const coderId = this.activeCoder,
                cwd = this.activeCWD,
                workspace = this.activeWorkspace;
            // Preserve the launch target even if the sidebar changes while
            // this request is in flight.
            const coder = getCoder(coderId);
            const coderName =
                BUILTIN_SESSION_TITLES.get(coderId) ??
                coder?.short_label ??
                coder?.name ??
                'Shell';
            const title = `+ ${coderName}`;

            const res = await fetch('/api/terminals', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    coder: coderId,
                    cwd,
                    session_id: '',
                    title: title,
                    workspace,
                    ...(mini ? { opencode_mini: true } : {}),
                }),
            });
            if (!res.ok) {
                const errText = await res.text().catch(() => 'unknown error');
                throw new Error(errText.trim() || 'Failed to spawn session');
            }

            const data = await res.json();
            this.app.tabManager.createTab(
                data.pane_id,
                data.session_id,
                title,
                coderId,
                workspace,
                cwd,
                // The trailing bridge value seeds the tab's ordered
                // model view; explicit defaults match createTab's.
                ...(coderId === 'opencode'
                    ? [
                          true,
                          false,
                          '',
                          null,
                          openCodePaneMode(data.opencode_mode),
                          data.pi_bridge,
                      ]
                    : [true, false, '', null, null, data.pi_bridge]),
            );

            this.loadSessions();
            if (coderId === 'opencode') {
                setTimeout(() => this.fetchOpenCodeServiceStatus(), 1200);
            }
        } catch (e) {
            this.app.showToast((e as Error).message, { type: 'error' });
        }
    }

    async launchSession(
        sessionId: string,
        title: string,
        extraArgs: string[] = [],
        mini: boolean = false,
    ): Promise<void> {
        try {
            const coderId = this.activeCoder,
                cwd = this.activeCWD,
                workspace = this.activeWorkspace;
            const res = await fetch('/api/terminals', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    coder: coderId,
                    cwd,
                    session_id: sessionId,
                    extra_args: extraArgs,
                    title: title,
                    workspace,
                    ...(mini ? { opencode_mini: true } : {}),
                }),
            });
            if (!res.ok) {
                const errText = await res.text().catch(() => 'unknown error');
                throw new Error(errText.trim() || 'Failed to connect session');
            }

            const data = await res.json();
            this.app.tabManager.createTab(
                data.pane_id,
                data.session_id,
                title,
                coderId,
                workspace,
                cwd,
                // The trailing bridge value seeds the tab's ordered
                // model view; explicit defaults match createTab's.
                ...(coderId === 'opencode'
                    ? [
                          true,
                          false,
                          '',
                          null,
                          openCodePaneMode(data.opencode_mode),
                          data.pi_bridge,
                      ]
                    : [true, false, '', null, null, data.pi_bridge]),
            );

            this.highlightActiveSession(sessionId);
            if (coderId === 'opencode') {
                setTimeout(() => this.fetchOpenCodeServiceStatus(), 1200);
            }
        } catch (e) {
            this.app.showToast((e as Error).message, { type: 'error' });
        }
    }

    _showSessionContextMenu(e: MouseEvent, item: HTMLElement, sess: any): void {
        this._dismissContextMenu();

        const menu = document.createElement('div');
        menu.className = 'session-ctx-menu';
        menu.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;z-index:9999`;

        const mkItem = (label: string, onClick: () => void) => {
            const el = document.createElement('div');
            el.className = 'session-ctx-item';
            el.textContent = label;
            el.addEventListener('click', () => {
                this._dismissContextMenu();
                onClick();
            });
            menu.appendChild(el);
        };

        mkItem('▶ Launch', () => {
            this.launchSession(sess.id, sess.title);
            const sidebar = document.getElementById('sidebar-panel');
            if (sidebar) sidebar.classList.remove('drawer-open');
        });

        if (this.activeCoder === 'opencode' && this._canOpenCodeMini()) {
            mkItem('Open Mini', () => {
                this.launchSession(sess.id, sess.title, [], true);
            });
        }

        mkItem('⚙ Launch with args…', () => {
            this._openArgsInput(item, sess);
        });

        if (hasRename(this.activeCoder)) {
            mkItem('✏ Rename', () => {
                this.openInlineRenamer(item, sess.id, sess.title);
            });
        }

        this._mountSessionContextMenu(e, menu);
    }

    updateOpenCodeServiceVisibility(): void {
        if (!this.openCodeServiceRow) return;
        const isV2OpenCode =
            this.activeCoder === 'opencode' && this._canOpenCodeMini();
        if (isV2OpenCode) {
            this.openCodeServiceRow.style.display = 'block';
            this.fetchOpenCodeServiceStatus();
            this._startOpenCodeServicePolling();
        } else {
            this.openCodeServiceRow.style.display = 'none';
            this._stopOpenCodeServicePolling();
        }
    }

    _startOpenCodeServicePolling(): void {
        if (this._openCodeServicePollTimer !== null) return;
        this._openCodeServicePollTimer = window.setInterval(() => {
            if (
                this.activeCoder === 'opencode' &&
                document.visibilityState === 'visible'
            ) {
                this.fetchOpenCodeServiceStatus();
            }
        }, 15000);
    }

    _stopOpenCodeServicePolling(): void {
        if (this._openCodeServicePollTimer !== null) {
            clearInterval(this._openCodeServicePollTimer);
            this._openCodeServicePollTimer = null;
        }
    }

    async fetchOpenCodeServiceStatus(): Promise<void> {
        if (!this.openCodeServiceBtn) return;
        try {
            const res = await fetch('/api/opencode/service');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = (await res.json()) as {
                supported: boolean;
                running: boolean;
                tabs?: number;
                error?: string;
                idle_stop_minutes?: number;
                idle_stop_remaining_seconds?: number;
            };
            if (!data.supported) {
                if (this.openCodeServiceRow) {
                    this.openCodeServiceRow.style.display = 'none';
                }
                return;
            }
            this.renderOpenCodeServiceStatus(
                Boolean(data.running),
                data.tabs || 0,
                data.idle_stop_minutes,
                data.idle_stop_remaining_seconds,
            );
        } catch {
            this.renderOpenCodeServiceError();
        }
    }

    renderOpenCodeServiceStatus(
        running: boolean,
        tabs: number,
        idleStopMinutes?: number,
        idleStopRemainingSeconds?: number,
    ): void {
        if (!this.openCodeServiceBtn) return;
        const label = this.openCodeServiceBtn.querySelector(
            '.opencode-service-label',
        ) as HTMLElement | null;

        if (running) {
            this.openCodeServiceBtn.setAttribute('data-state', 'running');
            this.openCodeServiceBtn.disabled = false;
            if (label) label.textContent = 'Kill server';
            const tabText =
                tabs > 0 ? ` (${tabs} active tab${tabs === 1 ? '' : 's'})` : '';
            let idleText = '';
            if (
                idleStopMinutes &&
                idleStopRemainingSeconds !== undefined &&
                idleStopRemainingSeconds >= 0
            ) {
                const remMins = Math.max(
                    1,
                    Math.round(idleStopRemainingSeconds / 60),
                );
                idleText = ` (auto-stops in ~${remMins}m if idle)`;
            }
            this.openCodeServiceBtn.title = `OpenCode background server is running${tabText}${idleText}. Click to kill server.`;
        } else {
            this.openCodeServiceBtn.setAttribute('data-state', 'stopped');
            this.openCodeServiceBtn.disabled = true;
            if (label) label.textContent = 'Server off';
            this.openCodeServiceBtn.title =
                'OpenCode background server is stopped (starts automatically on new session).';
        }
    }

    renderOpenCodeServiceError(): void {
        if (!this.openCodeServiceBtn) return;
        this.openCodeServiceBtn.setAttribute('data-state', 'error');
        this.openCodeServiceBtn.disabled = false;
        const label = this.openCodeServiceBtn.querySelector(
            '.opencode-service-label',
        ) as HTMLElement | null;
        if (label) label.textContent = 'Server: retry';
        this.openCodeServiceBtn.title =
            'Could not check OpenCode background server status. Click to retry.';
    }

    async stopOpenCodeService(force: boolean = false): Promise<void> {
        if (!this.openCodeServiceBtn) return;
        const label = this.openCodeServiceBtn.querySelector(
            '.opencode-service-label',
        ) as HTMLElement | null;
        this.openCodeServiceBtn.setAttribute('data-state', 'stopping');
        this.openCodeServiceBtn.disabled = true;
        if (label) label.textContent = 'Stopping…';
        this.openCodeServiceBtn.title = 'Stopping OpenCode background server…';

        try {
            const res = await fetch('/api/opencode/service/stop', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ force }),
            });

            if (res.status === 409) {
                const data = (await res.json().catch(() => ({}))) as {
                    tabs?: number;
                };
                const tabs = data.tabs || 1;
                const tabWord = tabs === 1 ? 'tab is' : 'tabs are';
                const confirmed = window.confirm(
                    `${tabs} OpenCode ${tabWord} currently running in Phi.\n\n` +
                        `Killing the server will disconnect active sessions.\n\n` +
                        `Kill the OpenCode background server anyway?`,
                );
                if (confirmed) {
                    await this.stopOpenCodeService(true);
                } else {
                    await this.fetchOpenCodeServiceStatus();
                }
                return;
            }

            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }

            await this.fetchOpenCodeServiceStatus();
        } catch {
            this.renderOpenCodeServiceError();
        }
    }

    _canOpenCodeMini(): boolean {
        const mode = getCoder('opencode')?.opencode_mode;
        return mode === 'tui' || mode === 'mini';
    }

    _showOpenCodeMiniMenu(e: MouseEvent, launch: () => void): void {
        this._dismissContextMenu();
        const menu = document.createElement('div');
        menu.className = 'session-ctx-menu';
        menu.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;z-index:9999`;
        const item = document.createElement('div');
        item.className = 'session-ctx-item';
        item.textContent = 'Open Mini';
        item.setAttribute('role', 'menuitem');
        item.tabIndex = 0;
        const activate = () => {
            this._dismissContextMenu();
            launch();
        };
        item.addEventListener('click', activate);
        item.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                activate();
            }
        });
        menu.appendChild(item);
        this._mountSessionContextMenu(e, menu);
    }

    _mountSessionContextMenu(e: MouseEvent, menu: HTMLElement): void {
        document.body.appendChild(menu);
        this._contextMenu = menu;

        // Adjust if menu would overflow viewport bottom
        const rect = menu.getBoundingClientRect();
        if (rect.bottom > window.innerHeight) {
            menu.style.top = `${e.clientY - rect.height}px`;
        }

        this._ctxDismissMousedown = (ev) => {
            if (!menu.contains(ev.target as Node)) this._dismissContextMenu();
        };
        this._ctxDismissKey = (ev) => {
            if (ev.key === 'Escape') this._dismissContextMenu();
        };
        setTimeout(() => {
            if (this._contextMenu !== menu) return;
            document.addEventListener('mousedown', this._ctxDismissMousedown!);
            document.addEventListener('keydown', this._ctxDismissKey!);
        }, 0);
    }

    _dismissContextMenu(): void {
        if (this._contextMenu) {
            this._contextMenu.remove();
            this._contextMenu = null;
        }
        if (this._ctxDismissMousedown) {
            document.removeEventListener(
                'mousedown',
                this._ctxDismissMousedown,
            );
            this._ctxDismissMousedown = null;
        }
        if (this._ctxDismissKey) {
            document.removeEventListener('keydown', this._ctxDismissKey);
            this._ctxDismissKey = null;
        }
    }

    _openArgsInput(item: HTMLElement, sess: any): void {
        const existing = item.nextElementSibling;
        if (existing?.classList.contains('args-input-row')) existing.remove();

        const row = document.createElement('div');
        row.className = 'args-input-row';

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'rename-input args-input';
        input.placeholder = 'extra args...';

        const hint = document.createElement('span');
        hint.className = 'args-input-hint';
        hint.textContent = '↵ launch · Esc cancel';

        row.appendChild(input);
        row.appendChild(hint);
        item.insertAdjacentElement('afterend', row);
        input.focus({ preventScroll: true });

        const submit = () => {
            const argsStr = input.value.trim();
            const extraArgs = argsStr
                ? argsStr.split(/\s+/).filter(Boolean)
                : [];
            row.remove();
            this.launchSession(sess.id, sess.title, extraArgs);
            const sidebar = document.getElementById('sidebar-panel');
            if (sidebar) sidebar.classList.remove('drawer-open');
        };

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                submit();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                row.remove();
            }
        });

        input.addEventListener('blur', () => {
            setTimeout(() => {
                if (document.body.contains(row)) row.remove();
            }, 150);
        });
    }

    openInlineRenamer(
        itemEl: HTMLElement,
        sessionId: string,
        currentTitle: string,
    ): void {
        const titleEl = itemEl.querySelector('.session-title');
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'rename-input';
        input.value = currentTitle;

        titleEl?.replaceWith(input);
        input.focus({ preventScroll: true });
        input.select();

        let state: 'editing' | 'saving' | 'finished' = 'editing';
        const finish = (title: string) => {
            if (state === 'finished') return;
            state = 'finished';
            if (input.isConnected) {
                const replacement = document.createElement('span');
                replacement.className = 'session-title';
                replacement.textContent = title;
                input.replaceWith(replacement);
            }
        };
        const saveRename = async () => {
            if (state !== 'editing') return;
            const newName = input.value.trim();
            if (!newName || newName === currentTitle) {
                finish(currentTitle);
                void this.loadSessions();
                return;
            }

            state = 'saving';
            try {
                const res = await fetch('/api/session-meta', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: sessionId, name: newName }),
                });
                if (!res.ok) throw new Error('Failed to save');
                finish(newName);
                void this.loadSessions();
            } catch (e) {
                alert(`Failed to rename: ${(e as Error).message}`);
                finish(currentTitle);
                void this.loadSessions();
            }
        };

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                void saveRename();
            } else if (e.key === 'Escape' && state === 'editing') {
                e.preventDefault();
                finish(currentTitle);
                void this.loadSessions();
            }
        });

        input.addEventListener('blur', () => {
            void saveRename();
        });
    }

    openWorkspaceModal(): void {
        if (!this.wsModal.classList.contains('hidden')) return;

        this.wsDialogGeneration++;
        this.wsDraftGeneration++;
        this.wsPathResolveId++;
        this.invalidateAutocompleteSuggestions();
        this.wsModalInput.value = '';
        this.wsModalPathStatus.textContent = '';
        this.wsModalOpener =
            document.activeElement instanceof HTMLElement &&
            document.activeElement !== document.body
                ? document.activeElement
                : this.addWorkspaceBtn;
        this.wsModal.classList.remove('hidden');
        this.wsModalAddBtn.disabled = this.wsSubmitPending;

        const onKeydown = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                this.closeWorkspaceModal();
                return;
            }
            if (event.key !== 'Tab') return;

            const focusable = Array.from(
                this.wsModal.querySelectorAll<HTMLElement>(
                    'button:not(:disabled):not([hidden]), input:not(:disabled), [tabindex="0"]',
                ),
            ).filter((element) => !element.closest('.hidden'));
            if (focusable.length === 0) {
                event.preventDefault();
                return;
            }
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            const activeIndex = focusable.indexOf(
                document.activeElement as HTMLElement,
            );
            if (event.shiftKey && activeIndex <= 0) {
                event.preventDefault();
                last.focus({ preventScroll: true });
            } else if (
                !event.shiftKey &&
                activeIndex === focusable.length - 1
            ) {
                event.preventDefault();
                first.focus({ preventScroll: true });
            }
        };
        const onFocusin = (event: FocusEvent): void => {
            if (
                !this.wsModal.classList.contains('hidden') &&
                event.target instanceof Node &&
                !this.wsModal.contains(event.target)
            ) {
                this.wsModalInput.focus({ preventScroll: true });
            }
        };
        this.wsModalKeydownHandler = onKeydown;
        this.wsModalFocusinHandler = onFocusin;
        document.addEventListener('keydown', onKeydown, true);
        document.addEventListener('focusin', onFocusin, true);

        const dialog = this.wsDialogGeneration;
        this.wsTreeController = mountDirectoryTree(this.wsModalTree, {
            startPath: this.activeWorkspace || '~',
            onSelect: (path) => {
                if (
                    dialog === this.wsDialogGeneration &&
                    !this.wsModal.classList.contains('hidden')
                ) {
                    this.onWorkspaceTreeSelect(path);
                }
            },
        });
        this.wsModalInput.focus({ preventScroll: true });
    }

    closeWorkspaceModal(): void {
        if (this.wsModal.classList.contains('hidden')) return;

        this.wsDialogGeneration++;
        this.wsDraftGeneration++;
        this.wsPathResolveId++;
        if (this.wsSubmitPending && !this.wsSubmitPostStarted) {
            this.wsSubmitOperationId++;
            this.wsSubmitPending = false;
            this.wsModalAddBtn.disabled = false;
        }
        this.invalidateAutocompleteSuggestions();
        this.wsTreeController?.destroy();
        this.wsTreeController = null;
        if (this.wsModalKeydownHandler) {
            document.removeEventListener(
                'keydown',
                this.wsModalKeydownHandler,
                true,
            );
            this.wsModalKeydownHandler = null;
        }
        if (this.wsModalFocusinHandler) {
            document.removeEventListener(
                'focusin',
                this.wsModalFocusinHandler,
                true,
            );
            this.wsModalFocusinHandler = null;
        }
        this.wsModal.classList.add('hidden');
        const opener = this.wsModalOpener;
        this.wsModalOpener = null;
        if (opener?.isConnected) opener.focus({ preventScroll: true });
    }

    onWorkspacePathInput(): void {
        this.wsDraftGeneration++;
        this.wsPathResolveId++;
        this.wsTreeController?.invalidateDraft();
        this.wsModalPathStatus.textContent = '';
        this.invalidateAutocompleteSuggestions();
        void this.fetchAutocompleteSuggestions();
    }

    onWorkspacePathKeydown(event: KeyboardEvent): void {
        if (this.wsModalComposing || event.isComposing) return;

        const items =
            this.wsModalSuggestions.querySelectorAll<HTMLElement>(
                '.suggestion-item',
            );
        if (
            (event.key === 'ArrowDown' || event.key === 'ArrowUp') &&
            items.length
        ) {
            event.preventDefault();
            if (event.key === 'ArrowDown') {
                this.selectedSuggestionIndex =
                    (this.selectedSuggestionIndex + 1) % items.length;
            } else {
                this.selectedSuggestionIndex =
                    this.selectedSuggestionIndex < 0
                        ? items.length - 1
                        : (this.selectedSuggestionIndex - 1 + items.length) %
                          items.length;
            }
            this.highlightSuggestion(items);
            return;
        }
        if (event.key !== 'Enter') return;

        event.preventDefault();
        if (
            this.selectedSuggestionIndex >= 0 &&
            this.selectedSuggestionIndex < items.length
        ) {
            this.acceptWorkspaceSuggestion(
                items[this.selectedSuggestionIndex].textContent ?? '',
            );
        }
        void this.revealWorkspacePath();
    }

    onWorkspaceTreeSelect(path: string): void {
        this.wsModalInput.value = path;
        this.wsDraftGeneration++;
        this.wsPathResolveId++;
        this.wsModalPathStatus.textContent = '';
        this.invalidateAutocompleteSuggestions();
    }

    invalidateAutocompleteSuggestions(): void {
        this.wsAutocompleteRequestId++;
        this.wsModalSuggestions.replaceChildren();
        this.wsModalSuggestions.classList.add('hidden');
        this.wsModalInput.setAttribute('aria-expanded', 'false');
        this.wsModalInput.removeAttribute('aria-activedescendant');
        this.selectedSuggestionIndex = -1;
    }

    acceptWorkspaceSuggestion(path: string): void {
        this.wsModalInput.value = path;
        this.wsDraftGeneration++;
        this.wsPathResolveId++;
        this.wsTreeController?.invalidateDraft();
        this.wsModalPathStatus.textContent = '';
        this.invalidateAutocompleteSuggestions();
    }

    async revealWorkspacePath(): Promise<void> {
        const path = this.wsModalInput.value.trim();
        const dialog = this.wsDialogGeneration;
        const draft = this.wsDraftGeneration;
        const operation = ++this.wsPathResolveId;
        const controller = this.wsTreeController;
        this.invalidateAutocompleteSuggestions();
        this.wsModalInput.focus({ preventScroll: true });

        if (!path) {
            this.wsModalPathStatus.textContent =
                'Enter a directory path to reveal.';
            return;
        }
        if (!controller) return;

        try {
            const resolved = await controller.reveal(path);
            if (
                resolved === null ||
                operation !== this.wsPathResolveId ||
                dialog !== this.wsDialogGeneration ||
                draft !== this.wsDraftGeneration ||
                this.wsModal.classList.contains('hidden')
            ) {
                return;
            }
            this.wsModalInput.value = resolved;
            this.wsModalPathStatus.textContent = '';
            this.wsModalInput.focus({ preventScroll: true });
        } catch {
            if (
                operation === this.wsPathResolveId &&
                dialog === this.wsDialogGeneration &&
                draft === this.wsDraftGeneration &&
                !this.wsModal.classList.contains('hidden')
            ) {
                this.wsModalPathStatus.textContent =
                    'This path is not an accessible directory.';
            }
        }
    }

    async submitWorkspaceModal(): Promise<void> {
        if (this.wsSubmitPending) return;

        const path = this.wsModalInput.value.trim();
        const dialog = this.wsDialogGeneration;
        const draft = this.wsDraftGeneration;
        const operation = ++this.wsPathResolveId;
        const controller = this.wsTreeController;
        if (!path) {
            this.wsModalPathStatus.textContent =
                'Enter a directory path to add.';
            return;
        }
        if (!controller) return;

        const submission = ++this.wsSubmitOperationId;
        this.wsSubmitPending = true;
        this.wsSubmitPostStarted = false;
        this.wsModalAddBtn.disabled = true;
        this.invalidateAutocompleteSuggestions();
        try {
            const resolved = await controller.reveal(path);
            if (
                resolved === null ||
                operation !== this.wsPathResolveId ||
                dialog !== this.wsDialogGeneration ||
                draft !== this.wsDraftGeneration ||
                submission !== this.wsSubmitOperationId ||
                this.wsModal.classList.contains('hidden')
            ) {
                return;
            }
            this.wsModalInput.value = resolved;
            this.wsSubmitPostStarted = true;
            await this.addWorkspace(resolved);
            if (
                operation === this.wsPathResolveId &&
                dialog === this.wsDialogGeneration &&
                draft === this.wsDraftGeneration &&
                !this.wsModal.classList.contains('hidden')
            ) {
                this.closeWorkspaceModal();
            }
        } catch (error) {
            if (
                operation === this.wsPathResolveId &&
                dialog === this.wsDialogGeneration &&
                draft === this.wsDraftGeneration &&
                !this.wsModal.classList.contains('hidden')
            ) {
                this.wsModalPathStatus.textContent =
                    error instanceof Error
                        ? error.message
                        : 'Failed to add workspace.';
            }
        } finally {
            if (submission === this.wsSubmitOperationId) {
                this.wsSubmitPending = false;
                this.wsSubmitPostStarted = false;
                this.wsModalAddBtn.disabled = false;
            }
        }
    }

    async fetchAutocompleteSuggestions(): Promise<void> {
        const value = this.wsModalInput.value;
        const dialog = this.wsDialogGeneration;
        const draft = this.wsDraftGeneration;
        const requestId = ++this.wsAutocompleteRequestId;
        if (!value || this.wsModal.classList.contains('hidden')) return;

        try {
            const res = await fetch(
                `/api/fs/autocomplete?path=${encodeURIComponent(value)}`,
            );
            if (!res.ok) throw new Error('Autocomplete request failed.');
            const suggestions = (await res.json()) as string[];
            if (
                requestId !== this.wsAutocompleteRequestId ||
                dialog !== this.wsDialogGeneration ||
                draft !== this.wsDraftGeneration ||
                value !== this.wsModalInput.value ||
                this.wsModal.classList.contains('hidden')
            ) {
                return;
            }

            this.wsModalSuggestions.replaceChildren();
            if (!Array.isArray(suggestions) || suggestions.length === 0) {
                this.wsModalSuggestions.classList.add('hidden');
                this.wsModalInput.setAttribute('aria-expanded', 'false');
                this.selectedSuggestionIndex = -1;
                return;
            }

            this.wsModalSuggestions.classList.remove('hidden');
            this.wsModalInput.setAttribute('aria-expanded', 'true');
            this.selectedSuggestionIndex = -1;
            for (const [index, suggestion] of suggestions.entries()) {
                if (typeof suggestion !== 'string') continue;
                const item = document.createElement('div');
                item.className = 'suggestion-item';
                item.id = `ws-modal-suggestion-${dialog}-${requestId}-${index}`;
                item.setAttribute('role', 'option');
                item.setAttribute('aria-selected', 'false');
                item.textContent = suggestion;
                item.addEventListener('click', () => {
                    this.acceptWorkspaceSuggestion(suggestion);
                    this.wsModalInput.focus({ preventScroll: true });
                });
                this.wsModalSuggestions.appendChild(item);
            }
            if (this.wsModalSuggestions.childElementCount === 0) {
                this.wsModalSuggestions.classList.add('hidden');
                this.wsModalInput.setAttribute('aria-expanded', 'false');
            }
        } catch (error) {
            if (
                requestId === this.wsAutocompleteRequestId &&
                dialog === this.wsDialogGeneration &&
                draft === this.wsDraftGeneration
            ) {
                console.error('[autocomplete] Suggestion fetch error:', error);
            }
        }
    }

    highlightSuggestion(items: NodeListOf<HTMLElement>): void {
        items.forEach((item, index) => {
            const selected = index === this.selectedSuggestionIndex;
            item.classList.toggle('selected', selected);
            item.setAttribute('aria-selected', String(selected));
            if (selected) {
                this.wsModalInput.setAttribute(
                    'aria-activedescendant',
                    item.id,
                );
                item.scrollIntoView?.({ block: 'nearest' });
            }
        });
    }

    async openReviewTab(sess: any): Promise<void> {
        // Existing coders keep their original tab IDs, including the
        // behavior of reopening a review by its session ID. Custom
        // backends use a scoped key to avoid collisions. Recognize
        // either key when reopening a tab created by an earlier build.
        const scope = sess.coder || this.activeCoder || 'unknown';
        const ws = sess.workspace || this.activeWorkspace || '';
        const scopedKey = `review:${encodeURIComponent(scope)}:${encodeURIComponent(ws)}:${encodeURIComponent(sess.id)}`;
        const legacyKey = `review-${sess.id}`;
        const paneId =
            getCoder(scope) && !BUILTIN_SESSION_TITLES.has(scope)
                ? scopedKey
                : legacyKey;
        const previousKey = paneId === legacyKey ? scopedKey : legacyKey;
        if (this.app.tabManager.tabs.has(paneId)) {
            this.app.tabManager.switchTab(paneId);
            return;
        }
        if (this.app.tabManager.tabs.has(previousKey)) {
            this.app.tabManager.switchTab(previousKey);
            return;
        }

        this.app.tabManager.createTab(
            paneId,
            sess.id,
            `Review: ${sess.title}`,
            'review',
            this.activeWorkspace,
            sess.cwd,
        );
        const activeTab = this.app.tabManager.tabs.get(paneId);
        if (!activeTab) return;
        const view = createReviewTranscriptView(activeTab.termContainer, {
            title: `Review: ${sess.title}`,
            coder: sess.coder,
            refresh: true,
            copyText: (text) =>
                this.app.tabManager.copyTextRobustly(text, true),
        });

        const loadData = async (): Promise<void> => {
            view.contentBody.innerHTML = `
                <div class="review-loading">
                    <span class="spinner"></span>
                    <span>Loading session transcript...</span>
                </div>
            `;
            try {
                // URLSearchParams encodes every value (R9); a session
                // id with `?` or `&` no longer corrupts the query.
                const params = new URLSearchParams({
                    coder: sess.coder || '',
                    id: sess.id || '',
                    cwd: sess.cwd || '',
                });
                const res = await fetch(
                    `/api/session-transcript?${params.toString()}`,
                );
                if (!res.ok) throw new Error('Failed to load transcript');
                const messages = await res.json();
                if (!Array.isArray(messages) || messages.length === 0) {
                    view.showEmpty();
                    return;
                }
                view.setMessages(
                    messages.map((message: any) => ({
                        role: String(message.role || 'assistant'),
                        text: String(message.text || ''),
                    })),
                );
                setTimeout(() => {
                    view.transcript.scrollTop = view.transcript.scrollHeight;
                }, 150);
            } catch (e) {
                view.contentBody.innerHTML = `
                    <div class="review-error">
                        <h3>Error loading transcript</h3>
                        <p>${(e as Error).message}</p>
                    </div>
                `;
            }
        };

        view.refreshButton?.addEventListener('click', loadData);
        await loadData();
    }

    // ─── Dynamic sidebar rendering (R9) ────────────────────────────────

    // renderCoderTabs populates #coder-selector from the registry,
    // filtering to sidebar-visible coders and preserving the order
    // the server declared. The click handler is delegated (see
    // setupEventListeners); this method only builds DOM nodes.
    //
    // Keep the current in-memory selection; the pre-registry sidebar
    // always started on OpenCode after a page reload.
    renderCoderTabs(): void {
        const container = document.getElementById('coder-selector');
        if (!container) return;
        const coders = visibleCoders();
        if (coders.length === 0) {
            // Registry hasn't loaded yet; keep the HTML fallback.
            return;
        }
        container.replaceChildren();
        const visibleIds = new Set(coders.map((c) => c.id));
        const activeId = visibleIds.has(this.activeCoder)
            ? this.activeCoder
            : coders[0].id;

        for (const c of coders) {
            const btn = document.createElement('button');
            btn.className = 'coder-tab';
            if (c.id === activeId) btn.classList.add('active');
            btn.setAttribute('data-coder', c.id);
            btn.setAttribute('title', BUILTIN_TAB_TITLES.get(c.id) ?? c.name);
            btn.appendChild(renderLogo(c));
            const label = document.createElement('span');
            label.textContent = c.short_label || c.name;
            btn.appendChild(label);
            container.appendChild(btn);
        }

        // Keep the application launcher and its listener across registry refreshes.
        // It shares the icon row, not the PTY/session-list selection flow.
        if (this.dshPreviewBtn) container.appendChild(this.dshPreviewBtn);

        // Sync the SessionsManager's active coder with the resolved
        // selection only when it actually changed; preserving the
        // user's pick across re-renders is what avoids the
        // jump-back regression the follow-up flagged.
        if (this.activeCoder !== activeId) {
            this.onSessionContextChange();
            this.activeCoder = activeId;
        }
        this.updateOpenCodeServiceVisibility?.();
        this.updateRefreshButtonVisibility();
        // loadConfig already calls loadSessions after rendering. Do not
        // make a second request or redraw the sidebar on every config load.
    }

    // renderQuickLaunchButtons populates the empty-state quick
    // launch row. Its built-in order differs from sidebar tab order.
    renderQuickLaunchButtons(): void {
        const container = document.getElementById('empty-quick-launch');
        if (!container) return;
        const rank = (id: string): number => {
            const index = QUICK_LAUNCH_ORDER.indexOf(id);
            return index < 0 ? Number.MAX_SAFE_INTEGER : index;
        };
        const coders = visibleCoders().sort((a, b) => rank(a.id) - rank(b.id));
        if (coders.length === 0) return;
        container.replaceChildren();
        for (const c of coders) {
            const btn = document.createElement('button');
            btn.className = 'empty-launch-btn';
            btn.setAttribute('data-coder', c.id);
            btn.textContent = c.short_label || c.name;
            container.appendChild(btn);
        }
    }
}
