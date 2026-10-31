/* Φ phi — Git Diff & Git Log Controller */

import type { AppLike } from './types.js';
import { PTYWebSocket } from './ws.js';
import {
    getLastFolderName,
    worktreeGlyph,
    isCoarseViewport,
    isDiffDrawerViewport,
    terminalPreferredFontSize,
    responsiveTerminalFontSize,
    DIFF_TERMINAL_TARGET_COLUMNS,
    openExternalLink,
    installTerminalLinkProvider,
    getEmbeddedBackendOrigin,
    getEmbeddedProfileId,
    serverKey,
} from './util.js';
import {
    buildVSCodeURI,
    buildVSCodeRemoteURI,
    normalizeHostname,
    isVSCodeLaunchUnsupported,
} from './vscode.js';

interface GitManageTarget {
    root: string;
    head: string;
    branch: string;
    remote: string;
    remote_ref: string;
    remote_token: string;
}

interface GitManageInfo {
    notGitRepo?: boolean;
    target?: GitManageTarget;
    can_pull_push: boolean;
    reason?: string;
    has_staged?: boolean;
    index_token?: string;
    can_commit?: boolean;
    commit_reason?: string;
}

type GitManageActionName = 'pull' | 'push' | 'commit';
type GitManageActionPhase =
    | 'queued'
    | 'sent'
    | 'confirmed'
    | 'failed'
    | 'blocked'
    | 'unconfirmed'
    | 'paused'
    | 'dismissed';

interface GitManageActionRecord {
    version: 1;
    id: string;
    owner: string;
    action: GitManageActionName;
    target: GitManageTarget;
    message?: string;
    indexToken?: string;
    phase: GitManageActionPhase;
    createdAt: number;
    status: string;
}

interface GitManageRequestContext {
    cwd: string;
    scopeRef: any;
    key: string;
    infoKey: string;
    actionPrefix: string;
    generation: number;
    headers: Record<string, string>;
    scopeSignal: AbortSignal | null;
    requestAvailable: boolean;
}

interface GitViewCacheEntry {
    version: 1;
    root: string;
    view: string;
    selection: string;
    text: string;
    head: string;
    branch: string;
    updatedAt: number;
}

class GitManageHTTPError extends Error {
    constructor(
        readonly status: number,
        readonly body: string,
    ) {
        super(`Git request failed (${status})`);
    }
}

const GIT_MANAGE_STORAGE_PREFIX = 'phi_git_manage_v1';
const GIT_VIEW_STORAGE_PREFIX = 'phi_git_view_v1';
const GIT_VIEW_CACHE_MAX_ENTRIES = 12;
const GIT_VIEW_CACHE_MAX_BYTES = 256 * 1024;
const GIT_INFO_TIMEOUT_MS = 30_000;
const GIT_ACTION_TIMEOUT_MS = 150_000;

function isGitManageTarget(value: unknown): value is GitManageTarget {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const target = value as Record<string, unknown>;
    return [
        'root',
        'head',
        'branch',
        'remote',
        'remote_ref',
        'remote_token',
    ].every((key) => typeof target[key] === 'string');
}

function sameGitManageTarget(
    a: GitManageTarget,
    b: GitManageTarget,
    action: GitManageActionName,
): boolean {
    return (
        a.root === b.root &&
        a.head === b.head &&
        a.branch === b.branch &&
        (action === 'commit' ||
            (a.remote === b.remote &&
                a.remote_ref === b.remote_ref &&
                a.remote_token === b.remote_token))
    );
}

function isGitManageInfo(value: unknown): value is GitManageInfo {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const info = value as Record<string, unknown>;
    if (info.notGitRepo === true) return true;
    return (
        typeof info.can_pull_push === 'boolean' &&
        isGitManageTarget(info.target) &&
        (info.reason === undefined || typeof info.reason === 'string') &&
        (info.has_staged === undefined ||
            typeof info.has_staged === 'boolean') &&
        (info.index_token === undefined ||
            typeof info.index_token === 'string') &&
        (info.can_commit === undefined ||
            typeof info.can_commit === 'boolean') &&
        (info.commit_reason === undefined ||
            typeof info.commit_reason === 'string')
    );
}

function normalizeGitManageInfo(info: GitManageInfo): GitManageInfo {
    if (info.notGitRepo) {
        return {
            notGitRepo: true,
            can_pull_push: false,
            has_staged: false,
            index_token: '',
            can_commit: false,
            commit_reason: '',
        };
    }
    return {
        ...info,
        has_staged: info.has_staged === true,
        index_token: info.index_token || '',
        can_commit: info.can_commit === true,
        commit_reason:
            info.commit_reason ||
            (info.can_commit === undefined
                ? 'Commit information is unavailable on this server.'
                : ''),
    };
}

function gitManageActionLabel(action: GitManageActionName): string {
    return action === 'pull' ? 'Pull' : action === 'push' ? 'Push' : 'Commit';
}

function isGitManageActionRecord(
    value: unknown,
): value is GitManageActionRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const record = value as Record<string, unknown>;
    return (
        record.version === 1 &&
        typeof record.id === 'string' &&
        typeof record.owner === 'string' &&
        (record.action === 'pull' ||
            record.action === 'push' ||
            record.action === 'commit') &&
        (record.action !== 'commit' ||
            (typeof record.message === 'string' &&
                typeof record.indexToken === 'string' &&
                /^[0-9a-f]{64}$/i.test(record.indexToken))) &&
        isGitManageTarget(record.target) &&
        typeof record.phase === 'string' &&
        [
            'queued',
            'sent',
            'confirmed',
            'failed',
            'blocked',
            'unconfirmed',
            'paused',
            'dismissed',
        ].includes(record.phase) &&
        typeof record.createdAt === 'number' &&
        typeof record.status === 'string'
    );
}

function gitManageActionId(): string {
    return `g_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// One inline review note attached to a specific (file, line) in the diff
// viewer. `codeSnippet` carries enough surrounding context for the staged
// prompt to be unambiguous to the downstream agent; `lineType` lets the
// renderer colour-code insert / delete / context consistently.
export interface DiffReviewComment {
    id: string;
    filePath: string;
    oldLineNumber: number | null;
    newLineNumber: number | null;
    lineType: 'insert' | 'delete' | 'context';
    // Which pane owns a context note in side-by-side view. Unified notes
    // default to the new/right pane; older drafts have no value here.
    displaySide?: 'old' | 'new';
    codeSnippet: string;
    commentText: string;
    createdAt: number;
}

// Localised info extracted from a rendered diff row. The row already
// knows the file (via the closest .d2h-file-wrapper ancestor) and its
// own line numbers; we capture both so the comment map key is unique
// across unified and side-by-side panes (each side of an insertion in
// side-by-side is a different row).
interface DiffLineInfo {
    filePath: string;
    oldLineNumber: number | null;
    newLineNumber: number | null;
    lineType: 'insert' | 'delete' | 'context';
}

// Normalize a CWD path for equality comparison between the active
// project context and a terminal tab's stored CWD. Handles:
//   - trailing slashes (e.g. '/projects/A' vs '/projects/A/')
//   - mixed separator styles (e.g. 'C:\\foo' vs 'C:/foo')
//
// Does NOT case-fold (path equality is OS-dependent: case-sensitive
// on Linux/macOS, case-insensitive on Windows). For phi this is fine
// because both sides are produced from the same os.Getwd / platform
// path-handling code.
export function normalizeCwd(p: string): string {
    if (!p) return '';
    return String(p).replace(/\\/g, '/').replace(/\/+$/, '');
}

// isUsableShell reports whether a tab is an alive bash/pwsh shell (not btop).
// Pure; returns a falsy value for null/undefined tabs (raw expression, kept
// as-is because callers only use it in boolean contexts).
export function isUsableShell(t: any): any {
    return (
        t &&
        !t.isDead &&
        (t.coder === 'bash' || t.coder === 'pwsh') &&
        t.title !== 'btop' &&
        !t.isBtop
    );
}

// findReusableShellTab picks the shell tab a quick-command should be sent to:
//   1. the active tab, if it is itself a usable shell (user focused it);
//   2. else, only when useExistingTerminalTab is on and activeCWD is set,
//      an alive shell whose CWD matches activeCWD (exact, per normalizeCwd);
//   3. else null (caller spawns a new shell).
// Pure over a plain iterable of tab-like objects.
export function findReusableShellTab(
    tabs: Iterable<any>,
    activeTab: any,
    {
        useExistingTerminalTab,
        activeCWD,
    }: { useExistingTerminalTab?: boolean; activeCWD?: string } = {},
): any {
    if (isUsableShell(activeTab)) return activeTab;
    const cwd = activeCWD || '';
    if (useExistingTerminalTab && cwd) {
        const wantedCWD = normalizeCwd(cwd);
        const match = Array.from(tabs).find(
            (t) => isUsableShell(t) && normalizeCwd(t.cwd || '') === wantedCWD,
        );
        if (match) return match;
    }
    return null;
}

export class DiffController {
    app: AppLike;
    activeTab: string; // 'diff' | 'log'
    currentWs: PTYWebSocket | null;
    term: any;
    fitAddon: any;
    isPanelOpen: boolean;
    diffPanel: HTMLElement;
    headerDiffToggleBtn: HTMLElement;
    closeDiffBtn: HTMLElement;
    refreshDiffBtn: HTMLElement;
    copyDiffBtn: HTMLElement | null;
    diffTermContainer: HTMLElement;
    commitSelect: HTMLSelectElement | null;
    modalCommitSelect: HTMLSelectElement | null;
    actionBar: HTMLElement | null;
    richDiffBtn: HTMLElement | null;
    diffModal: HTMLElement | null;
    diffModalClose: HTMLElement | null;
    diffModalBody: HTMLElement | null;
    contextToggleBtn: HTMLElement | null;
    layoutToggleBtn: HTMLElement | null;
    syntaxToggleBtn: HTMLElement | null;
    modalSizeToggleBtn: HTMLElement | null;
    vscodeLocalBtn: HTMLAnchorElement | null;
    vscodeRemoteBtn: HTMLAnchorElement | null;
    vscodeUnsupported: boolean;
    // Active context snapshot for diff render: the project root we
    // last accepted for the current rich-diff render. The per-file
    // editor actions and the file-list anchors are built from this
    // single snapshot, so a project switch replaces every action at
    // once. Null means "no accepted render yet" — late fetches must
    // never install links against an earlier server's identity.
    activeDiffRoot: string | null;
    activeDiffHostname: string;
    syntaxHighlightEnabled: boolean;
    currentContextLines: number;
    currentLayout: string;
    lastRawDiffText: string;
    activeBatchResults: any = null;
    commandContextMenuAbort: AbortController | null;
    // Monotonically increasing counter for loadRichDiff fetches. Late
    // responses (after a project switch or commit change) no longer
    // match and must be discarded without touching the rendered DOM.
    _richDiffRequestToken: number = 0;
    // Same idea for the streaming terminal path. A late `/api/diff`
    // response must not adopt its socket or paint its checkpoint into a
    // panel the user has already switched away from.
    _diffStreamToken: number = 0;
    // Late commit-list requests must not repopulate the selector with
    // hashes from a backend that has already been switched away from.
    _commitLoadToken: number = 0;
    _switchMarkdownCachePainted: boolean = false;
    // Diff review comment state. The map keys are the row's logical
    // identity (file + both line numbers) so switching between unified
    // and side-by-side panes preserves the user's notes; localStorage
    // gives us the same across modal open/close.
    reviewComments: Map<string, DiffReviewComment>;
    reviewActionBar: HTMLElement | null;
    reviewStorageKey: string;
    activeGitHead: string;
    activeGitBranch: string;
    gitPullBtn: HTMLButtonElement | null;
    gitPushBtn: HTMLButtonElement | null;
    gitCommitBtn: HTMLButtonElement | null;
    gitCommitMessageInput: HTMLTextAreaElement | null;
    gitCommitDraftStatusElement: HTMLElement | null;
    gitCommitDraftKey = '';
    gitCommitDraftMemory = new Map<string, string>();
    gitCommitDraftStatus = '';
    gitTargetLabel: HTMLElement | null;
    gitActionStatus: HTMLElement | null;
    gitActionResumeBtn: HTMLButtonElement | null;
    gitActionCancelBtn: HTMLButtonElement | null;
    gitActionDismissBtn: HTMLButtonElement | null;
    gitManageInfo: GitManageInfo | null = null;
    gitManageInfoKey = '';
    gitManageContextKey = '';
    gitManageRequestKey = '';
    gitManageGeneration = 0;
    gitManageBusy = false;
    gitManageStatus = '';
    gitManageRecord: GitManageActionRecord | null = null;
    gitManageRecordKey = '';
    gitManagePageId = gitManageActionId();
    gitManageMemory = new Map<string, GitManageInfo>();
    gitViewMemory = new Map<string, GitViewCacheEntry>();
    gitManageCancels = new Set<(message: string) => void>();
    gitManageRetryTimer: ReturnType<typeof setTimeout> | null = null;
    gitManageRetryDelay = 1000;
    // Commits selected from Sync Board can be older than the recent list.
    // Keep the explicit option only while this project and selection match.
    syncCommitTarget: { hash: string; cwd: string } | null = null;
    // Optional overrides used by unit tests + the fallback path in
    // _reviewStorageKeyForCwd. Production always reads through
    // this.app.sessionsManager; tests sometimes pass it directly for
    // terseness.
    sessionsManager?: any;

    constructor(app: AppLike) {
        this.app = app;
        this.activeTab = 'markdown'; // 'diff' | 'log'
        this.currentWs = null;
        this.term = null;
        this.fitAddon = null;
        this.isPanelOpen = true;

        this.diffPanel = document.getElementById('diff-panel')!;
        this.headerDiffToggleBtn = document.getElementById(
            'header-diff-toggle-btn',
        )!;
        this.closeDiffBtn = document.getElementById('close-diff-btn')!;
        this.refreshDiffBtn = document.getElementById('refresh-diff-btn')!;
        this.copyDiffBtn = document.getElementById('copy-diff-btn');
        this.diffTermContainer = document.getElementById(
            'diff-term-container',
        )!;
        this.commitSelect = document.getElementById(
            'diff-commit-select',
        ) as HTMLSelectElement;
        this.modalCommitSelect = document.getElementById(
            'diff-modal-commit-select',
        ) as HTMLSelectElement | null;
        this.actionBar = document.getElementById('diff-action-bar');
        this.richDiffBtn = document.getElementById('rich-diff-btn');
        this.diffModal = document.getElementById('diff-modal');
        this.diffModalClose = document.getElementById('diff-modal-close');
        this.diffModalBody = document.getElementById('diff-modal-body');
        this.contextToggleBtn = document.getElementById(
            'diff-context-toggle-btn',
        );
        this.layoutToggleBtn = document.getElementById(
            'diff-layout-toggle-btn',
        );
        this.syntaxToggleBtn = document.getElementById(
            'diff-syntax-toggle-btn',
        );
        this.modalSizeToggleBtn = document.getElementById(
            'diff-modal-size-btn',
        );
        this.vscodeLocalBtn = document.getElementById(
            'diff-vscode-local-btn',
        ) as HTMLAnchorElement | null;
        this.vscodeRemoteBtn = document.getElementById(
            'diff-vscode-remote-btn',
        ) as HTMLAnchorElement | null;
        // Hidden on surfaces that cannot dispatch vscode: URIs (the
        // desktop main view + any embedded Electron view). The
        // rich-diff per-file actions check this same flag and stay
        // out of the DOM in that case.
        this.vscodeUnsupported = isVSCodeLaunchUnsupported();
        if (this.vscodeUnsupported) {
            this.vscodeLocalBtn?.remove();
            this.vscodeRemoteBtn?.remove();
            this.vscodeLocalBtn = null;
            this.vscodeRemoteBtn = null;
        }
        this.activeDiffRoot = null;
        this.activeDiffHostname = '';
        try {
            this.syntaxHighlightEnabled =
                localStorage.getItem('phi_diff_syntax_highlight') === 'true';
        } catch {
            this.syntaxHighlightEnabled = false;
        }
        this.currentContextLines = 3;
        this.currentLayout = 'line-by-line'; // Default unified
        this.lastRawDiffText = '';
        this.commandContextMenuAbort = null;
        this.reviewComments = new Map();
        this.reviewActionBar = null;
        // localStorage key namespaces drafts by CWD so switching
        // worktrees doesn't bleed comments across projects.
        this.reviewStorageKey = 'phi_diff_review_draft';
        this.activeGitHead = '';
        this.activeGitBranch = '';
        this.gitPullBtn = document.getElementById(
            'git-pull-btn',
        ) as HTMLButtonElement | null;
        this.gitPushBtn = document.getElementById(
            'git-push-btn',
        ) as HTMLButtonElement | null;
        this.gitCommitBtn = document.getElementById(
            'git-commit-btn',
        ) as HTMLButtonElement | null;
        this.gitCommitMessageInput = document.getElementById(
            'git-commit-message',
        ) as HTMLTextAreaElement | null;
        this.gitCommitDraftStatusElement = document.getElementById(
            'git-commit-draft-status',
        );
        this.gitTargetLabel = document.getElementById('git-target-label');
        this.gitActionStatus = document.getElementById('git-action-status');
        this.gitActionResumeBtn = document.getElementById(
            'git-action-resume-btn',
        ) as HTMLButtonElement | null;
        this.gitActionCancelBtn = document.getElementById(
            'git-action-cancel-btn',
        ) as HTMLButtonElement | null;
        this.gitActionDismissBtn = document.getElementById(
            'git-action-dismiss-btn',
        ) as HTMLButtonElement | null;

        this._loadReviewDraft();
        this.setupEventListeners();
    }

    setupEventListeners(): void {
        // Toggle panel states
        this.closeDiffBtn.addEventListener('click', () =>
            this.togglePanel(false),
        );
        this.headerDiffToggleBtn.addEventListener('click', () => {
            this.togglePanel(!this.isPanelOpen);
        });

        // Copy button: copies the current xterm selection if there is one,
        // otherwise dumps the whole buffer (trimmed) so the user doesn't
        // have to drag-select to grab a small diff.
        if (this.copyDiffBtn) {
            this.copyDiffBtn.addEventListener('click', () => {
                if (this.term) {
                    const sel = this.term.getSelection();
                    if (sel) {
                        this.app.tabManager.copyTextRobustly(sel);
                    } else {
                        this.copyDiffBuffer();
                    }
                }
            });
        }

        // Rich diff modal triggering
        if (this.richDiffBtn) {
            this.richDiffBtn.addEventListener('click', () =>
                this.openRichDiffModal(),
            );
        }
        if (this.diffModalClose) {
            this.diffModalClose.addEventListener('click', () =>
                this.closeRichDiffModal(),
            );
        }
        if (this.diffModal) {
            this.diffModal.addEventListener('click', (e) => {
                if (e.target === this.diffModal) this.closeRichDiffModal();
            });
        }
        // Escape closes the rich-diff modal — matches the pattern in
        // markdown.js (md-modal) and app.js (ws-modal). Document-level
        // listener so we don't need to manage focus to capture Escape.
        document.addEventListener('keydown', (e) => {
            if (
                e.key === 'Escape' &&
                this.diffModal &&
                !this.diffModal.classList.contains('hidden')
            ) {
                this.closeRichDiffModal();
                return;
            }
            // Cmd/Ctrl+Shift+Enter: stage pending review comments into
            // the terminal prompt. Only fires when the modal is open
            // AND we actually have something to apply, so the chord
            // stays inert in unrelated modals.
            if (
                e.key === 'Enter' &&
                e.shiftKey &&
                (e.metaKey || e.ctrlKey) &&
                this.diffModal &&
                !this.diffModal.classList.contains('hidden') &&
                this.reviewComments.size > 0
            ) {
                e.preventDefault();
                this.applyReviewToTerminalPrompt();
            }
        });
        if (this.contextToggleBtn) {
            this.contextToggleBtn.textContent =
                this.currentContextLines === 3
                    ? 'More context'
                    : 'Less context';
            this.contextToggleBtn.addEventListener('click', () =>
                this.toggleRichDiffContext(),
            );
        }
        if (this.layoutToggleBtn) {
            this.layoutToggleBtn.addEventListener('click', () =>
                this.toggleRichDiffLayout(),
            );
        }
        if (this.syntaxToggleBtn) {
            this.syntaxToggleBtn.addEventListener('click', () =>
                this.toggleRichDiffSyntax(),
            );
            this._updateSyntaxToggleBtn();
        }
        this.modalSizeToggleBtn?.addEventListener('click', () =>
            this.toggleRichDiffSize(),
        );

        // Manual Refresh trigger
        this.refreshDiffBtn.addEventListener('click', () => this.refreshDiff());
        this.gitPullBtn?.addEventListener('click', () =>
            this.startGitAction('pull'),
        );
        this.gitPushBtn?.addEventListener('click', () =>
            this.startGitAction('push'),
        );
        this.gitCommitBtn?.addEventListener('click', () =>
            this.startGitAction('commit'),
        );
        this.gitCommitMessageInput?.addEventListener('input', () => {
            if (!this.gitCommitDraftKey) {
                const value = this.gitCommitMessageInput?.value || '';
                const context = this.captureGitManageContext();
                if (this.gitCommitMessageInput)
                    this.gitCommitMessageInput.value = value;
                this.gitCommitDraftKey = `${context.key}:commit-draft`;
            }
            this.gitCommitDraftMemory.set(
                this.gitCommitDraftKey,
                this.gitCommitMessageInput?.value || '',
            );
            this.persistGitCommitDraft();
            this.renderGitManagement();
        });
        this.gitActionResumeBtn?.addEventListener('click', () =>
            this.resumeGitAction(),
        );
        this.gitActionCancelBtn?.addEventListener('click', () =>
            this.cancelGitAction(),
        );
        this.gitActionDismissBtn?.addEventListener('click', () =>
            this.dismissGitAction(),
        );
        window.addEventListener('online', () => this.wakeGitManageQueue());

        // Diff sub-tabs
        document.querySelectorAll('.diff-tab-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                document
                    .querySelector('.diff-tab-btn.active')
                    ?.classList.remove('active');
                btn.classList.add('active');
                this.activeTab = btn.getAttribute('data-tab') as string;
                this.refreshDiff(false); // Reload commit list when changing tabs
                if (this.activeTab === 'markdown' && this.app.markdownManager) {
                    this.app.markdownManager.refreshFiles({ force: false });
                } else if (this.activeTab === 'sync' && this.app.syncManager) {
                    this.app.syncManager.refreshMessages();
                }
            });
        });

        if (this.commitSelect) {
            this.commitSelect.addEventListener('change', () => {
                this.syncCommitTarget = null;
                this._syncModalCommitSelect();
                void this.refreshDiff(true); // Don't reload the list when user just changes selection
                if (
                    this.diffModal &&
                    !this.diffModal.classList.contains('hidden')
                ) {
                    void this.loadRichDiff();
                }
            });
        }
        this.modalCommitSelect?.addEventListener('change', () => {
            if (!this.commitSelect || !this.modalCommitSelect) return;
            this.syncCommitTarget = null;
            this.commitSelect.value = this.modalCommitSelect.value;
            void this.refreshDiff(true);
            void this.loadRichDiff();
        });

        // Debounced resize fitting — suppressed for software-keyboard
        // geometry (height-only change on touch shells) under the NEVER
        // contract: the keyboard must not refit, resend, or scroll the
        // diff terminal either. Width changes and fine-pointer resizes
        // keep the immediate path.
        let resizeTimeout: ReturnType<typeof setTimeout>;
        let lastW = window.innerWidth;
        let lastH = window.innerHeight;
        window.addEventListener('resize', () => {
            const w = window.innerWidth;
            const h = window.innerHeight;
            const heightOnly = w === lastW && h !== lastH;
            lastW = w;
            lastH = h;
            if (heightOnly && isCoarseViewport()) return;
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(() => {
                if (this.isPanelOpen) this.fitTerminal();
            }, 150);
        });
    }

    initTerminal(): void {
        this.term = new window.Terminal({
            cursorBlink: false,
            cursorStyle: 'underline',
            fontSize: terminalPreferredFontSize(this.app.terminalFontSize),
            fontFamily:
                this.app.terminalFontFamily || 'JetBrains Mono, monospace',
            theme: {
                background: '#08080a',
                foreground: '#e4e3e9',
                cursor:
                    document.documentElement.style.getPropertyValue(
                        '--accent',
                    ) || '#7c6af7',
                cursorAccent: '#08080a',
                black: '#08080a',
                red: '#ef4444',
                green: '#38bdf8',
                yellow: '#fbbf24',
                blue: '#3b82f6',
                magenta: '#7c6af7',
                cyan: '#06b6d4',
                white: '#e4e3e9',
            },
            linkHandler: {
                activate: (_e: MouseEvent, text: string) => {
                    openExternalLink(text);
                },
            },
        });

        this.fitAddon = new window.FitAddon.FitAddon();
        this.term.loadAddon(this.fitAddon);

        installTerminalLinkProvider(this.term);

        this.term.open(this.diffTermContainer);

        // Graceful WebGL load
        try {
            const webgl = new window.WebglAddon.WebglAddon();
            this.term.loadAddon(webgl);
        } catch (_e) {
            /* WebGL is a progressive enhancement; ignore load failure */
        }

        // Copy plumbing for the diff/status/log pane. The main terminal
        // wires these (terminal.js:817-878) so users can drag-select +
        // Cmd-C / Ctrl-Shift-C / right-click to copy. The diff xterm
        // was missing all of them, so even though xterm keeps an internal
        // selection model, Cmd-C fell through to the browser, saw a canvas
        // (WebGL renders to <canvas>), and copied nothing - hence the
        // user-visible "git output is an image" bug.
        //
        // We reuse this.app.tabManager.copyTextRobustly (handles clipboard
        // permission + execCommand fallback for insecure contexts).
        this._wireCopyHandlers(this.term, this.diffTermContainer);

        // Diff only docks once both side panels still leave the terminal
        // an 80-column working grid. Below that it is a drawer and defaults
        // closed unless the user explicitly opened it before.
        const openState = localStorage.getItem('phi_diff_panel_open');
        const shouldOpen = isDiffDrawerViewport()
            ? openState === 'true'
            : openState !== 'false';
        this.togglePanel(shouldOpen);
    }

    // Port of terminal.js:817-878 copy wiring, scoped to whichever xterm
    // is passed in. Three entry points for selection copying:
    //   1. onSelectionChange -> silent auto-copy (matches main terminal)
    //   2. Cmd-C / Ctrl-Shift-C keydown -> copy via clipboard (skip if no selection)
    //   3. Right-click contextmenu -> copy via clipboard (skip if no selection)
    // Plus a public copyAll() helper for the Copy button that dumps the
    // whole buffer when there's no active selection.
    _wireCopyHandlers(term: any, termContainer: HTMLElement): void {
        const copy = (text: string, silent?: boolean) => {
            if (!text) return;
            this.app.tabManager.copyTextRobustly(text, silent);
        };

        term.onSelectionChange(() => {
            const sel = term.getSelection();
            if (sel) copy(sel, true); // silent: matches main-terminal behavior
        });

        termContainer.addEventListener(
            'contextmenu',
            (e) => {
                const sel = term.getSelection();
                if (!sel) return;
                e.preventDefault();
                e.stopPropagation();
                copy(sel);
            },
            { capture: true },
        );

        term.attachCustomKeyEventHandler((e: any) => {
            if (e.type === 'keydown') {
                const isMac =
                    navigator.platform.toUpperCase().indexOf('MAC') >= 0;
                const isCopy =
                    (isMac && e.metaKey && e.key.toLowerCase() === 'c') ||
                    (!isMac &&
                        e.ctrlKey &&
                        e.shiftKey &&
                        e.key.toLowerCase() === 'c');
                if (isCopy) {
                    const sel = term.getSelection();
                    if (sel) {
                        copy(sel);
                        e.preventDefault();
                        return false;
                    }
                }
                // Allow zoom shortcuts (Ctrl/Cmd +, -, 0, =) to pass through
                if ((e.ctrlKey || e.metaKey) && !e.altKey) {
                    const k = e.key;
                    if (
                        k === '+' ||
                        k === '=' ||
                        k === '-' ||
                        k === '_' ||
                        k === '0' ||
                        k === 'Add' ||
                        k === 'Subtract'
                    ) {
                        return false;
                    }
                }
                // Allow reload / reconnect shortcuts (F5, Shift+F5, Ctrl+Shift+R) to pass through
                if (
                    e.key === 'F5' ||
                    e.code === 'F5' ||
                    ((e.ctrlKey || e.metaKey) &&
                        (e.key === 'r' || e.key === 'R'))
                ) {
                    return false;
                }
            }
            return true;
        });
    }

    // Dump the whole xterm buffer as plain text, trimming trailing empty
    // lines (xterm pads the buffer with whitespace rows). Used by the
    // "Copy" toolbar button when the user wants everything without
    // bothering to drag-select.
    copyDiffBuffer(): void {
        if (!this.term) return;
        const lines: string[] = [];
        const buffer = this.term.buffer.active;
        for (let i = 0; i < buffer.length; i++) {
            const line = buffer.getLine(i);
            if (!line) continue;
            lines.push(line.translateToString(true));
        }
        // Trim trailing empty/whitespace-only lines so pasted output
        // doesn't have a wall of blank padding at the end.
        while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
        const text = lines.join('\n');
        this.app.tabManager.copyTextRobustly(text);
    }

    togglePanel(isOpen: boolean): void {
        this.isPanelOpen = isOpen;
        try {
            localStorage.setItem('phi_diff_panel_open', String(isOpen));
        } catch {
            /* Storage can be unavailable; panel visibility still applies. */
        }

        if (isOpen) {
            this.diffPanel.classList.remove('hidden');
            // mobile-open is the mobile-only opt-in that slides the
            // diff drawer in. Desktop ignores this class entirely.
            this.diffPanel.classList.add('mobile-open');
            this.headerDiffToggleBtn.classList.add('active');
            setTimeout(() => {
                this.fitTerminal();
                this.refreshDiff();
            }, 50);
        } else {
            this.diffPanel.classList.add('hidden');
            this.diffPanel.classList.remove('mobile-open');
            this.headerDiffToggleBtn.classList.remove('active');
            if (this.currentWs) {
                this.currentWs.close();
                this.currentWs = null;
            }
        }

        // Let terminal tab fit after layout shift
        setTimeout(() => {
            this.app.tabManager.fitActiveTerminal();
        }, 150);
    }

    fitTerminal(): void {
        if (!this.term || !this.isPanelOpen) return;
        try {
            const proposed = this.fitAddon?.proposeDimensions?.();
            const size = responsiveTerminalFontSize(
                terminalPreferredFontSize(this.app.terminalFontSize),
                Number(this.term.options.fontSize),
                proposed?.cols,
                DIFF_TERMINAL_TARGET_COLUMNS,
            );
            if (this.term.options.fontSize !== size) {
                this.term.options.fontSize = size;
            }
            this.fitAddon.fit();
            if (this.currentWs && this.term.cols && this.term.rows) {
                this.currentWs.sendResize(this.term.cols, this.term.rows);
            }
        } catch (e) {
            console.error('[diff] Fit error:', e);
        }
    }

    // The settings preference is intentionally a preferred reading scale;
    // fitTerminal resolves the actual size from this panel's measured grid.
    applyFontSize(): void {
        this.fitTerminal();
    }

    applyFontFamily(family: string): void {
        if (!this.term) return;
        this.term.options.fontFamily = family || 'JetBrains Mono, monospace';
        this.fitTerminal();
    }

    _writeStaticTerminalOutput(text: string, emptyText: string): void {
        this.fitTerminal();
        this.term.reset();
        this.term.clear();
        const normalized = (text || '').replace(/\r?\n/g, '\r\n');
        this.term.write(normalized?.trim() ? normalized : emptyText);
    }

    _setPanel(mode: string): void {
        this._closeCommandContextMenu?.();
        const termEl = document.getElementById('diff-term-container')!;
        const mdEl = document.getElementById('markdown-file-list')!;
        const cmdEl = document.getElementById('cmd-panel');
        const syncEl = document.getElementById('sync-panel');
        const ftEl = document.getElementById('file-tree-list');
        const ftToolbar = document.getElementById('file-tree-toolbar');
        if (mode === 'markdown') {
            termEl.classList.add('hidden');
            mdEl.classList.remove('hidden');
            cmdEl?.classList.add('hidden');
            syncEl?.classList.add('hidden');
            ftEl?.classList.add('hidden');
            ftToolbar?.classList.add('hidden');
            this.actionBar?.classList.add('hidden');
        } else if (mode === 'sync') {
            termEl.classList.add('hidden');
            mdEl.classList.add('hidden');
            cmdEl?.classList.add('hidden');
            syncEl?.classList.remove('hidden');
            ftEl?.classList.add('hidden');
            ftToolbar?.classList.add('hidden');
            this.actionBar?.classList.add('hidden');
        } else if (mode === 'cmd') {
            termEl.classList.add('hidden');
            mdEl.classList.add('hidden');
            cmdEl?.classList.remove('hidden');
            syncEl?.classList.add('hidden');
            ftEl?.classList.add('hidden');
            ftToolbar?.classList.add('hidden');
            this.actionBar?.classList.add('hidden');
        } else if (mode === 'files') {
            termEl.classList.add('hidden');
            mdEl.classList.add('hidden');
            cmdEl?.classList.add('hidden');
            syncEl?.classList.add('hidden');
            ftEl?.classList.remove('hidden');
            ftToolbar?.classList.remove('hidden');
            this.actionBar?.classList.add('hidden');
        } else {
            termEl.classList.remove('hidden');
            mdEl.classList.add('hidden');
            cmdEl?.classList.add('hidden');
            syncEl?.classList.add('hidden');
            ftEl?.classList.add('hidden');
            ftToolbar?.classList.add('hidden');
            const diffTab = this.activeTab === 'diff';
            const gitTab =
                diffTab ||
                this.activeTab === 'log' ||
                this.activeTab === 'status';
            this.actionBar?.classList.toggle('hidden', !gitTab);
            this.commitSelect?.classList.toggle('hidden', !diffTab);
            this.richDiffBtn?.classList.toggle('hidden', !diffTab);
            if (diffTab) {
                this._refreshDiffProjectActions();
            } else {
                this.vscodeLocalBtn?.classList.add('hidden');
                this.vscodeRemoteBtn?.classList.add('hidden');
            }
        }
    }

    /** Update the diff action bar's VS Code project buttons. Local and
     *  remote are independent: local can be available when remote is
     *  not (invalid hostname) or vice versa. Called on every panel
     *  open and on every accepted rich-diff response so a server
     *  switch replaces the URIs synchronously. */
    _refreshDiffProjectActions(): void {
        if (this.vscodeUnsupported) return;
        if (!this.vscodeLocalBtn || !this.vscodeRemoteBtn) return;
        const root = this.app.sessionsManager?.activeCWD || '';
        const localURI = buildVSCodeURI(root);
        const hostname = normalizeHostname(this.app.hostname);
        const remoteURI = buildVSCodeRemoteURI(hostname, {
            root,
            kind: 'folder',
        });
        const apply = (
            btn: HTMLAnchorElement,
            uri: string | null,
            isRemote: boolean,
        ): void => {
            if (!uri) {
                btn.setAttribute('aria-disabled', 'true');
                btn.removeAttribute('href');
                btn.title = isRemote
                    ? 'Open project in VS Code through SSH (no Phi hostname available)'
                    : 'Open project in VS Code (no active project)';
            } else {
                btn.removeAttribute('aria-disabled');
                btn.setAttribute('href', uri);
                btn.title = isRemote
                    ? `Open ${root} in VS Code through SSH to ${hostname}`
                    : `Open ${root} in VS Code`;
            }
        };
        apply(this.vscodeLocalBtn, localURI, false);
        apply(this.vscodeRemoteBtn, remoteURI, true);
    }

    _syncModalCommitSelect(): void {
        if (!this.modalCommitSelect || !this.commitSelect) return;
        this.modalCommitSelect.replaceChildren(
            ...Array.from(this.commitSelect.options, (option) =>
                option.cloneNode(true),
            ),
        );
        this.modalCommitSelect.value = this.commitSelect.value;
    }

    _ensureCommitOption(hash: string): void {
        const selects = [this.commitSelect, this.modalCommitSelect].filter(
            (select): select is HTMLSelectElement => select !== null,
        );
        for (const select of selects) {
            if (!Array.from(select.options).some((o) => o.value === hash)) {
                const option = document.createElement('option');
                option.value = hash;
                option.textContent = `${hash} — Sync Board commit`;
                select.appendChild(option);
            }
            select.value = hash;
        }
    }

    private captureGitManageContext(): GitManageRequestContext {
        const scope = this.app.scope;
        const cwd = String(this.app.sessionsManager?.activeCWD || '');
        const profileId = String(
            scope?.profileId || getEmbeddedProfileId() || '',
        );
        const origin = String(
            scope?.origin ||
                getEmbeddedBackendOrigin() ||
                window.location.origin ||
                '',
        );
        const normalizedCwd = normalizeCwd(cwd);
        const key = `${serverKey(GIT_MANAGE_STORAGE_PREFIX)}:${encodeURIComponent(profileId)}:${encodeURIComponent(origin)}:${encodeURIComponent(normalizedCwd)}`;
        let headers: Record<string, string> = {};
        let requestAvailable = true;
        try {
            if (typeof scope?.headers === 'function') {
                headers = { ...scope.headers() };
            } else if (profileId) {
                headers['X-Phi-Backend'] = profileId;
            }
        } catch {
            requestAvailable = false;
        }
        if (this.gitManageContextKey !== key) {
            this.persistGitCommitDraft();
            if (this.gitManageRecord?.phase === 'queued') {
                this.gitManageRecord.phase = 'paused';
                this.gitManageRecord.status =
                    'Queued Git action paused. Resume to verify before sending.';
                this.writeGitManageAction(
                    this.gitManageRecordKey,
                    this.gitManageRecord,
                );
            }
            this.clearGitManageRetry();
            for (const cancel of this.gitManageCancels) {
                cancel('Git context changed');
            }
            this.gitManageCancels.clear();
            this.gitManageGeneration++;
            this.gitManageContextKey = key;
            this.restoreGitCommitDraft(`${key}:commit-draft`);
            this.gitManageInfoKey = `${key}:info`;
            this.gitManageInfo = this.readGitManageInfo(this.gitManageInfoKey);
            const restored = this.readGitManageAction(`${key}:action:`);
            this.gitManageRecord = restored?.record || null;
            this.gitManageRecordKey = restored?.storageKey || '';
            this.gitManageBusy = false;
            this.gitManageStatus =
                this.gitManageRecord?.status ||
                (this.gitManageInfo ? '' : 'No cached Git information');
            this.gitManageRequestKey = '';
            this.renderGitManagement();
        }
        return {
            cwd,
            scopeRef: scope,
            key,
            infoKey: `${key}:info`,
            actionPrefix: `${key}:action:`,
            generation: this.gitManageGeneration,
            headers,
            scopeSignal: scope?.signal || null,
            requestAvailable,
        };
    }

    private persistGitCommitDraft(): void {
        if (!this.gitCommitMessageInput || !this.gitCommitDraftKey) return;
        this.gitCommitDraftMemory.set(
            this.gitCommitDraftKey,
            this.gitCommitMessageInput.value,
        );
        try {
            localStorage.setItem(
                this.gitCommitDraftKey,
                this.gitCommitMessageInput.value,
            );
            this.gitCommitDraftStatus = '';
        } catch {
            this.gitCommitDraftStatus =
                'Draft not saved on this device. Keep this page open.';
        }
    }

    private clearGitCommitDraftAfterSuccess(): void {
        if (!this.gitCommitMessageInput || !this.gitCommitDraftKey) return;
        try {
            localStorage.setItem(this.gitCommitDraftKey, '');
            this.gitCommitDraftMemory.set(this.gitCommitDraftKey, '');
            this.gitCommitMessageInput.value = '';
            this.gitCommitDraftStatus = '';
        } catch {
            this.gitCommitDraftMemory.set(
                this.gitCommitDraftKey,
                this.gitCommitMessageInput.value,
            );
            this.gitCommitDraftStatus =
                'Draft not saved on this device. Keep this page open.';
        }
    }

    private restoreGitCommitDraft(key: string): void {
        this.gitCommitDraftKey = key;
        if (!this.gitCommitMessageInput) return;
        const memoryDraft = this.gitCommitDraftMemory.get(key);
        if (memoryDraft !== undefined) {
            this.gitCommitMessageInput.value = memoryDraft;
            this.gitCommitDraftStatus = '';
            return;
        }
        this.gitCommitMessageInput.value = '';
        try {
            const draft = localStorage.getItem(key) || '';
            this.gitCommitMessageInput.value = draft;
            this.gitCommitDraftMemory.set(key, draft);
            this.gitCommitDraftStatus = '';
        } catch {
            this.gitCommitDraftStatus =
                'Draft not saved on this device. Keep this page open.';
        }
    }

    private readGitManageInfo(key: string): GitManageInfo | null {
        const memory = this.gitManageMemory.get(key);
        if (memory) return memory;
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return null;
            const parsed: unknown = JSON.parse(raw);
            if (!isGitManageInfo(parsed)) return null;
            const info = normalizeGitManageInfo(parsed);
            this.gitManageMemory.set(key, info);
            return info;
        } catch {
            return null;
        }
    }

    private readGitManageAction(
        prefix: string,
    ): { record: GitManageActionRecord; storageKey: string } | null {
        try {
            const candidates: {
                record: GitManageActionRecord;
                storageKey: string;
                unresolved: boolean;
            }[] = [];
            for (let i = 0; i < localStorage.length; i++) {
                const storageKey = localStorage.key(i);
                if (!storageKey?.startsWith(prefix)) continue;
                let parsed: unknown;
                try {
                    parsed = JSON.parse(
                        localStorage.getItem(storageKey) || 'null',
                    );
                } catch {
                    // One corrupt record must not hide other sent actions.
                    continue;
                }
                if (
                    !isGitManageActionRecord(parsed) ||
                    parsed.phase === 'dismissed' ||
                    localStorage.getItem(
                        `${this.gitManageContextKey}:dismissed:${encodeURIComponent(parsed.id)}`,
                    ) === '1'
                ) {
                    continue;
                }
                let record = parsed;
                if (record.phase === 'sent') {
                    record = {
                        ...record,
                        phase: 'unconfirmed',
                        status: 'Result unconfirmed. Inspect Git state before running again.',
                    };
                } else if (record.phase === 'queued') {
                    record = {
                        ...record,
                        phase: 'paused',
                        status: 'Queued Git action paused. Resume to verify before sending.',
                    };
                }
                candidates.push({
                    record,
                    storageKey,
                    unresolved: [
                        'queued',
                        'sent',
                        'unconfirmed',
                        'paused',
                    ].includes(parsed.phase),
                });
            }
            candidates.sort(
                (a, b) =>
                    Number(b.unresolved) - Number(a.unresolved) ||
                    b.record.createdAt - a.record.createdAt,
            );
            return candidates[0] || null;
        } catch {
            return null;
        }
    }

    private renderGitManagement(): void {
        const info = this.gitManageInfo;
        const target = info?.target;
        if (this.gitTargetLabel) {
            if (info?.notGitRepo) {
                this.gitTargetLabel.textContent = 'Not a Git repository';
            } else if (target) {
                const branch = target.branch || 'Detached HEAD';
                const upstream = target.remote
                    ? `${target.remote}:${target.remote_ref || 'no upstream'}`
                    : 'No remote upstream';
                this.gitTargetLabel.textContent = `${target.root}\nBranch ${branch} · ${upstream}`;
            } else {
                this.gitTargetLabel.textContent = 'No cached Git information';
            }
        }
        const actionWaiting =
            this.gitManageBusy ||
            ['queued', 'sent', 'paused', 'unconfirmed'].includes(
                this.gitManageRecord?.phase || '',
            );
        const disabled = !info?.can_pull_push || !target || actionWaiting;
        if (this.gitPullBtn) {
            this.gitPullBtn.disabled = disabled;
            this.gitPullBtn.title =
                info?.reason || 'Fast-forward from the configured upstream';
        }
        if (this.gitPushBtn) {
            this.gitPushBtn.disabled = disabled;
            this.gitPushBtn.title =
                info?.reason ||
                'Push the current branch to its configured upstream';
        }
        if (this.gitCommitBtn) {
            this.gitCommitBtn.disabled =
                !info?.can_commit ||
                !target ||
                !/^[0-9a-f]{64}$/i.test(info.index_token || '') ||
                !this.gitCommitMessageInput?.value.trim() ||
                actionWaiting;
            this.gitCommitBtn.title =
                info?.commit_reason ||
                'Commit only the currently staged changes';
        }
        if (this.gitCommitDraftStatusElement) {
            this.gitCommitDraftStatusElement.textContent =
                this.gitCommitDraftStatus;
            this.gitCommitDraftStatusElement.classList.toggle(
                'hidden',
                !this.gitCommitDraftStatus,
            );
        }
        const paused = this.gitManageRecord?.phase === 'paused';
        const unconfirmed = this.gitManageRecord?.phase === 'unconfirmed';
        this.gitActionResumeBtn?.classList.toggle('hidden', !paused);
        this.gitActionCancelBtn?.classList.toggle(
            'hidden',
            !(paused || this.gitManageRecord?.phase === 'queued'),
        );
        this.gitActionDismissBtn?.classList.toggle('hidden', !unconfirmed);
        if (this.gitActionStatus) {
            this.gitActionStatus.textContent =
                this.gitManageStatus || info?.reason || '';
        }
        document
            .getElementById('git-management')
            ?.setAttribute('aria-busy', String(this.gitManageBusy));
    }

    private isCurrentGitManageContext(
        context: GitManageRequestContext,
    ): boolean {
        return (
            this.gitManageContextKey === context.key &&
            this.gitManageGeneration === context.generation &&
            this.app.scope === context.scopeRef &&
            normalizeCwd(this.app.sessionsManager?.activeCWD || '') ===
                normalizeCwd(context.cwd)
        );
    }

    private async requestGitManage<T>(
        context: GitManageRequestContext,
        path: string,
        init: RequestInit,
        timeoutMs: number,
        consume: (response: Response) => Promise<T>,
    ): Promise<T> {
        if (!context.requestAvailable) {
            throw new Error('Git backend request context is unavailable');
        }
        const controller = new AbortController();
        let rejectAbort: (reason?: unknown) => void = () => {};
        const aborted = new Promise<never>((_resolve, reject) => {
            rejectAbort = reject;
        });
        let cancelled = false;
        const cancel = (message: string) => {
            if (cancelled) return;
            cancelled = true;
            controller.abort();
            rejectAbort(new DOMException(message, 'AbortError'));
        };
        const scopeSignal = context.scopeSignal;
        const onScopeAbort = () => cancel('Backend scope changed');
        if (scopeSignal?.aborted) {
            onScopeAbort();
        } else {
            scopeSignal?.addEventListener('abort', onScopeAbort, {
                once: true,
            });
        }
        const timer = setTimeout(
            () => cancel('Git request timed out'),
            timeoutMs,
        );
        this.gitManageCancels.add(cancel);
        const extraHeaders = (init.headers || {}) as Record<string, string>;
        const headers = { ...context.headers, ...extraHeaders };
        const operation = (async () => {
            const response = await fetch(path, {
                ...init,
                headers,
                signal: controller.signal,
                credentials: 'same-origin',
            });
            return consume(response);
        })();
        try {
            if (controller.signal.aborted) return await aborted;
            return await Promise.race([operation, aborted]);
        } finally {
            clearTimeout(timer);
            scopeSignal?.removeEventListener('abort', onScopeAbort);
            this.gitManageCancels.delete(cancel);
        }
    }

    private async fetchGitManageInfo(
        context: GitManageRequestContext,
    ): Promise<GitManageInfo> {
        const query = new URLSearchParams({ cwd: context.cwd });
        return this.requestGitManage(
            context,
            `/api/git/info?${query}`,
            { method: 'GET', cache: 'no-store' },
            GIT_INFO_TIMEOUT_MS,
            async (response) => {
                const body = await response.text();
                if (!response.ok)
                    throw new GitManageHTTPError(response.status, body);
                let parsed: unknown;
                try {
                    parsed = JSON.parse(body);
                } catch {
                    throw new Error('Invalid Git information response');
                }
                if (!isGitManageInfo(parsed))
                    throw new Error('Invalid Git information response');
                return normalizeGitManageInfo(parsed);
            },
        );
    }

    private cacheGitManageInfo(
        context: GitManageRequestContext,
        info: GitManageInfo,
    ): void {
        info = normalizeGitManageInfo(info);
        this.gitManageMemory.set(context.infoKey, info);
        try {
            localStorage.setItem(context.infoKey, JSON.stringify(info));
        } catch {
            /* In-memory state remains usable when browser storage is unavailable. */
        }
    }

    private gitViewRoot(context: GitManageRequestContext): string {
        return normalizeCwd(this.gitManageInfo?.target?.root || context.cwd);
    }

    private gitViewCacheKey(
        context: GitManageRequestContext,
        root: string,
        view: string,
        selection: string,
    ): string {
        return `${GIT_VIEW_STORAGE_PREFIX}:${encodeURIComponent(context.key)}:${encodeURIComponent(root)}:${encodeURIComponent(view)}:${encodeURIComponent(selection)}`;
    }

    private readGitViewCache(
        context: GitManageRequestContext,
        root: string,
        view: string,
        selection: string,
    ): GitViewCacheEntry | null {
        const key = this.gitViewCacheKey(context, root, view, selection);
        const memory = this.gitViewMemory.get(key);
        if (memory) return memory;
        try {
            const parsed: unknown = JSON.parse(
                localStorage.getItem(key) || 'null',
            );
            if (
                !parsed ||
                typeof parsed !== 'object' ||
                Array.isArray(parsed)
            ) {
                return null;
            }
            const entry = parsed as GitViewCacheEntry;
            if (
                entry.version !== 1 ||
                entry.root !== root ||
                entry.view !== view ||
                entry.selection !== selection ||
                typeof entry.text !== 'string' ||
                typeof entry.head !== 'string' ||
                typeof entry.branch !== 'string' ||
                typeof entry.updatedAt !== 'number'
            ) {
                return null;
            }
            this.gitViewMemory.set(key, entry);
            return entry;
        } catch {
            return null;
        }
    }

    private cacheGitView(
        context: GitManageRequestContext,
        root: string,
        view: string,
        selection: string,
        text: string,
        head = '',
        branch = '',
    ): void {
        const key = this.gitViewCacheKey(context, root, view, selection);
        const entry: GitViewCacheEntry = {
            version: 1,
            root,
            view,
            selection,
            text,
            head,
            branch,
            updatedAt: Date.now(),
        };
        this.gitViewMemory.set(key, entry);
        const serialized =
            text.length <= GIT_VIEW_CACHE_MAX_BYTES
                ? JSON.stringify(entry)
                : '';
        if (
            serialized &&
            new TextEncoder().encode(serialized).byteLength <=
                GIT_VIEW_CACHE_MAX_BYTES
        ) {
            const prefix = `${GIT_VIEW_STORAGE_PREFIX}:${encodeURIComponent(context.key)}:${encodeURIComponent(root)}:`;
            try {
                localStorage.setItem(key, serialized);
                const saved: { key: string; updatedAt: number }[] = [];
                for (let index = 0; index < localStorage.length; index++) {
                    const savedKey = localStorage.key(index);
                    if (!savedKey?.startsWith(prefix)) continue;
                    try {
                        const value = JSON.parse(
                            localStorage.getItem(savedKey) || 'null',
                        );
                        if (typeof value?.updatedAt === 'number') {
                            saved.push({
                                key: savedKey,
                                updatedAt: value.updatedAt,
                            });
                        }
                    } catch {
                        /* Ignore unrelated or corrupt entries. */
                    }
                }
                saved.sort((a, b) => b.updatedAt - a.updatedAt);
                for (const stale of saved.slice(GIT_VIEW_CACHE_MAX_ENTRIES)) {
                    localStorage.removeItem(stale.key);
                    this.gitViewMemory.delete(stale.key);
                }
            } catch {
                /* Keep the successful view in memory if browser storage is full. */
            }
        }
        const memoryPrefix = `${GIT_VIEW_STORAGE_PREFIX}:${encodeURIComponent(context.key)}:${encodeURIComponent(root)}:`;
        const memoryKeys = [...this.gitViewMemory.keys()].filter((item) =>
            item.startsWith(memoryPrefix),
        );
        memoryKeys.sort(
            (a, b) =>
                (this.gitViewMemory.get(b)?.updatedAt || 0) -
                (this.gitViewMemory.get(a)?.updatedAt || 0),
        );
        for (const stale of memoryKeys.slice(GIT_VIEW_CACHE_MAX_ENTRIES)) {
            this.gitViewMemory.delete(stale);
        }
    }

    private paintGitViewCache(
        entry: GitViewCacheEntry | null,
        view: string,
        emptyText: string,
    ): boolean {
        if (!entry || !this.term) return false;
        if (entry.text === 'NOT_GIT_REPO') {
            this._writeStaticTerminalOutput(
                '',
                `\x1b[90mNot a git repository — the ${view} is empty for this workspace.\x1b[0m\r\n`,
            );
        } else {
            this._writeStaticTerminalOutput(entry.text, emptyText);
        }
        this.activeGitHead = entry.head;
        this.activeGitBranch = entry.branch;
        return true;
    }

    private refreshGitManagement(context: GitManageRequestContext): void {
        this.renderGitManagement();
        if (!context.cwd) {
            this.gitManageStatus = 'Select a workspace to view Git actions.';
            this.renderGitManagement();
            return;
        }
        const requestKey = `${context.key}:${context.generation}`;
        if (this.gitManageRequestKey === requestKey) return;
        if (!context.requestAvailable) {
            this.gitManageStatus =
                'Git information unavailable for the selected backend.';
            this.renderGitManagement();
            return;
        }
        this.gitManageRequestKey = requestKey;
        void this.fetchGitManageInfo(context)
            .then((info) => {
                if (!this.isCurrentGitManageContext(context)) return;
                this.cacheGitManageInfo(context, info);
                this.gitManageInfo = info;
                this.gitManageInfoKey = context.infoKey;
                if (!this.gitManageRecord) this.gitManageStatus = '';
                this.renderGitManagement();
            })
            .catch(() => {
                if (!this.isCurrentGitManageContext(context)) return;
                this.gitManageStatus =
                    this.gitManageRecord?.phase === 'queued'
                        ? this.gitManageRecord.status
                        : this.gitManageInfo
                          ? 'Git information refresh failed; showing the last saved target.'
                          : 'Git information is unavailable. Refresh to try again.';
                this.renderGitManagement();
            })
            .finally(() => {
                if (this.gitManageRequestKey === requestKey)
                    this.gitManageRequestKey = '';
            });
    }

    private wakeGitManageQueue(): void {
        const context = this.captureGitManageContext();
        const record = this.gitManageRecord;
        if (
            !context.requestAvailable ||
            !record ||
            record.phase !== 'queued' ||
            this.gitManageBusy
        ) {
            return;
        }
        this.clearGitManageRetry();
        this.gitManageRetryDelay = 1000;
        this.gitManageBusy = true;
        record.status = `Preparing ${gitManageActionLabel(record.action)}…`;
        this.gitManageStatus = record.status;
        this.renderGitManagement();
        void this.dispatchGitAction(context, record, this.gitManageRecordKey);
    }

    private clearGitManageRetry(): void {
        if (this.gitManageRetryTimer !== null) {
            clearTimeout(this.gitManageRetryTimer);
            this.gitManageRetryTimer = null;
        }
    }

    private scheduleGitManageRetry(
        context: GitManageRequestContext,
        record: GitManageActionRecord,
        storageKey: string,
    ): void {
        if (
            !this.isCurrentGitManageContext(context) ||
            this.gitManageRecord !== record ||
            record.phase !== 'queued'
        ) {
            return;
        }
        if (!this.ownsGitManageAction(storageKey, record)) {
            record.phase = 'paused';
            record.status =
                'Git action ownership changed. Resume here to revalidate.';
            this.gitManageStatus = record.status;
            this.gitManageBusy = false;
            this.renderGitManagement();
            return;
        }
        this.clearGitManageRetry();
        const delay = this.gitManageRetryDelay;
        this.gitManageRetryDelay = Math.min(delay * 2, 30_000);
        const seconds = Math.max(1, Math.ceil(delay / 1000));
        record.status = `Phi unavailable; retrying ${gitManageActionLabel(record.action)} in ${seconds}s. Cancel to stop.`;
        this.gitManageStatus = record.status;
        this.gitManageBusy = false;
        this.writeGitManageAction(storageKey, record);
        this.renderGitManagement();
        this.gitManageRetryTimer = setTimeout(() => {
            this.gitManageRetryTimer = null;
            if (
                !this.isCurrentGitManageContext(context) ||
                this.gitManageRecord !== record ||
                record.phase !== 'queued'
            ) {
                return;
            }
            this.gitManageBusy = true;
            record.status = `Preparing ${gitManageActionLabel(record.action)}…`;
            this.gitManageStatus = record.status;
            this.renderGitManagement();
            void this.dispatchGitAction(context, record, storageKey);
        }, delay);
    }

    private writeGitManageAction(
        storageKey: string,
        record: GitManageActionRecord,
        requireNew = false,
    ): boolean {
        try {
            const raw = localStorage.getItem(storageKey);
            if (requireNew && raw !== null) return false;
            if (raw !== null) {
                const existing: unknown = JSON.parse(raw);
                if (
                    !isGitManageActionRecord(existing) ||
                    existing.id !== record.id ||
                    existing.owner !== record.owner ||
                    (existing.phase === 'sent' &&
                        ['queued', 'paused'].includes(record.phase))
                ) {
                    return false;
                }
            }
            try {
                localStorage.setItem(storageKey, JSON.stringify(record));
                return true;
            } catch (error) {
                const name = (error as { name?: unknown })?.name;
                if (
                    record.phase !== 'sent' ||
                    (name !== 'QuotaExceededError' &&
                        name !== 'NS_ERROR_DOM_QUOTA_REACHED')
                ) {
                    return false;
                }
                try {
                    this.evictGitViewCacheForTarget(record.target.root);
                    localStorage.setItem(storageKey, JSON.stringify(record));
                    return true;
                } catch {
                    return false;
                }
            }
        } catch {
            return false;
        }
    }

    private evictGitViewCacheForTarget(root: string): void {
        const prefix = `${GIT_VIEW_STORAGE_PREFIX}:${encodeURIComponent(this.gitManageContextKey)}:${encodeURIComponent(root)}:`;
        const keys: string[] = [];
        for (let index = 0; index < localStorage.length; index++) {
            const key = localStorage.key(index);
            if (key?.startsWith(prefix)) keys.push(key);
        }
        for (const key of keys) localStorage.removeItem(key);
    }

    private ownsGitManageAction(
        storageKey: string,
        record: GitManageActionRecord,
    ): boolean {
        try {
            const stored: unknown = JSON.parse(
                localStorage.getItem(storageKey) || 'null',
            );
            return (
                isGitManageActionRecord(stored) &&
                stored.id === record.id &&
                stored.owner === this.gitManagePageId &&
                stored.phase === 'queued'
            );
        } catch {
            return false;
        }
    }

    private claimGitManageAction(
        storageKey: string,
        current: GitManageActionRecord,
        claimed: GitManageActionRecord,
    ): boolean {
        try {
            const stored: unknown = JSON.parse(
                localStorage.getItem(storageKey) || 'null',
            );
            if (
                !isGitManageActionRecord(stored) ||
                stored.id !== current.id ||
                !['queued', 'paused'].includes(stored.phase)
            ) {
                return false;
            }
            localStorage.setItem(storageKey, JSON.stringify(claimed));
            return true;
        } catch {
            return false;
        }
    }

    async startGitAction(action: GitManageActionName): Promise<void> {
        const context = this.captureGitManageContext();
        const info = this.gitManageInfo;
        const message = this.gitCommitMessageInput?.value || '';
        const target = info?.target;
        if (!context.requestAvailable) {
            this.gitManageStatus =
                'Git backend request context is unavailable. Refresh before trying again.';
            this.renderGitManagement();
            return;
        }
        if (action === 'commit' && !message.trim()) {
            this.gitManageStatus = 'Enter a commit message.';
            this.renderGitManagement();
            return;
        }
        const targetAvailable =
            action === 'commit'
                ? info?.can_commit === true &&
                  info.has_staged === true &&
                  /^[0-9a-f]{64}$/i.test(info.index_token || '')
                : info?.can_pull_push === true &&
                  isGitManageTarget(target) &&
                  /^[0-9a-f]{64}$/i.test(target.remote_token);
        if (!targetAvailable || !isGitManageTarget(target)) {
            this.gitManageStatus =
                (action === 'commit' ? info?.commit_reason : info?.reason) ||
                'Git target is unavailable. Refresh before trying again.';
            this.renderGitManagement();
            return;
        }
        if (
            this.gitManageBusy ||
            ['queued', 'sent', 'paused', 'unconfirmed'].includes(
                this.gitManageRecord?.phase || '',
            )
        ) {
            this.gitManageStatus =
                this.gitManageRecord?.status ||
                'Resolve the previous Git action before starting another.';
            this.renderGitManagement();
            return;
        }
        const actionTarget = { ...target };
        if (action === 'commit') {
            actionTarget.remote = '';
            actionTarget.remote_ref = '';
            actionTarget.remote_token = '';
        }
        const record: GitManageActionRecord = {
            version: 1,
            id: gitManageActionId(),
            owner: this.gitManagePageId,
            action,
            target: actionTarget,
            ...(action === 'commit'
                ? { message, indexToken: info?.index_token || '' }
                : {}),
            phase: 'queued',
            createdAt: Date.now(),
            status: `Preparing ${gitManageActionLabel(action)}…`,
        };
        const storageKey = `${context.actionPrefix}${record.id}`;
        this.clearGitManageRetry();
        this.gitManageRetryDelay = 1000;
        this.gitManageRecord = record;
        this.gitManageRecordKey = storageKey;
        this.gitManageStatus = record.status;
        this.gitManageBusy = true;
        if (!this.writeGitManageAction(storageKey, record, true)) {
            record.phase = 'paused';
            record.status =
                'Git action not sent: browser storage is unavailable. Retry explicitly.';
            this.gitManageStatus = record.status;
            this.gitManageBusy = false;
            this.renderGitManagement();
            return;
        }
        this.renderGitManagement();
        await this.dispatchGitAction(context, record, storageKey);
    }

    private async dispatchGitAction(
        context: GitManageRequestContext,
        record: GitManageActionRecord,
        storageKey: string,
    ): Promise<void> {
        try {
            const fresh = await this.fetchGitManageInfo(context);
            if (
                !this.isCurrentGitManageContext(context) ||
                this.gitManageRecord !== record ||
                this.gitManageRecordKey !== storageKey ||
                record.phase !== 'queued'
            ) {
                return;
            }
            if (!this.ownsGitManageAction(storageKey, record)) {
                record.phase = 'paused';
                record.status =
                    'Git action ownership changed. Resume here to revalidate.';
                this.gitManageStatus = record.status;
                this.gitManageBusy = false;
                this.renderGitManagement();
                return;
            }
            this.cacheGitManageInfo(context, fresh);
            this.gitManageInfo = fresh;
            this.gitManageInfoKey = context.infoKey;
            const freshTarget = isGitManageTarget(fresh.target)
                ? { ...fresh.target }
                : null;
            if (freshTarget && record.action === 'commit') {
                freshTarget.remote = '';
                freshTarget.remote_ref = '';
                freshTarget.remote_token = '';
            }
            const actionAvailable =
                record.action === 'commit'
                    ? fresh.can_commit === true &&
                      fresh.has_staged === true &&
                      fresh.index_token === record.indexToken
                    : fresh.can_pull_push;
            if (
                !actionAvailable ||
                !freshTarget ||
                !sameGitManageTarget(record.target, freshTarget, record.action)
            ) {
                record.phase = 'blocked';
                record.status = `Git target changed or ${gitManageActionLabel(record.action)} is unavailable. Refresh and click again.`;
                this.writeGitManageAction(storageKey, record);
                this.gitManageRecord = record;
                this.gitManageStatus = record.status;
                this.gitManageBusy = false;
                this.renderGitManagement();
                return;
            }
            record.phase = 'sent';
            record.status = `${gitManageActionLabel(record.action)} sent; waiting for confirmation.`;
            if (!this.writeGitManageAction(storageKey, record)) {
                record.phase = 'paused';
                record.status =
                    'Git action not sent: the sent marker could not be saved.';
                this.gitManageRecord = record;
                this.gitManageStatus = record.status;
                this.gitManageBusy = false;
                this.renderGitManagement();
                return;
            }
            this.gitManageRecord = record;
            this.gitManageStatus = record.status;
            this.renderGitManagement();
            const result = await this.requestGitManage(
                context,
                '/api/git/action',
                {
                    method: 'POST',
                    redirect: 'error',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        cwd: context.cwd,
                        action: record.action,
                        target: record.target,
                        ...(record.action === 'commit'
                            ? {
                                  message: record.message,
                                  index_token: record.indexToken,
                              }
                            : {}),
                    }),
                },
                GIT_ACTION_TIMEOUT_MS,
                async (response) => ({
                    status: response.status,
                    ok: response.ok,
                    body: await response.text(),
                }),
            );
            if (result.ok && result.status === 200) {
                let payload: any;
                try {
                    payload = JSON.parse(result.body);
                } catch {
                    payload = null;
                }
                if (
                    payload?.action === record.action &&
                    payload?.root === record.target.root &&
                    typeof payload?.output === 'string' &&
                    payload.output.length > 0
                ) {
                    const messageInput = this.gitCommitMessageInput;
                    if (
                        this.isCurrentGitManageContext(context) &&
                        record.action === 'commit' &&
                        messageInput &&
                        messageInput.value === record.message
                    ) {
                        this.clearGitCommitDraftAfterSuccess();
                    }
                    this.finishGitAction(
                        context,
                        record,
                        storageKey,
                        'confirmed',
                        `${gitManageActionLabel(record.action)} completed.`,
                    );
                    this.refreshAfterGitAction(context);
                    return;
                }
                this.finishGitAction(
                    context,
                    record,
                    storageKey,
                    'unconfirmed',
                    'Result unconfirmed. Inspect Git state before running again.',
                );
                return;
            }
            const errorBody = result.body.trim();
            if (
                result.status === 500 &&
                errorBody ===
                    `Git ${record.action} failed. Partial effects are possible. Inspect Git before running again.`
            ) {
                this.finishGitAction(
                    context,
                    record,
                    storageKey,
                    'failed',
                    `Git ${record.action} failed. Partial effects are possible. Inspect Git before running again.`,
                );
                this.refreshAfterGitAction(context);
                return;
            }
            if (
                result.status === 504 ||
                errorBody ===
                    'Git result unconfirmed. Inspect Git state before running again.' ||
                result.status >= 500
            ) {
                this.finishGitAction(
                    context,
                    record,
                    storageKey,
                    'unconfirmed',
                    'Result unconfirmed. Inspect Git state before running again.',
                );
                return;
            }
            this.finishGitAction(
                context,
                record,
                storageKey,
                'blocked',
                `Git action rejected (HTTP ${result.status}). Refresh the target before trying again.`,
            );
            this.refreshAfterGitAction(context);
        } catch (error) {
            if (record.phase === 'sent') {
                this.finishGitAction(
                    context,
                    record,
                    storageKey,
                    'unconfirmed',
                    'Result unconfirmed. Inspect Git state before running again.',
                );
            } else if (
                this.isCurrentGitManageContext(context) &&
                this.gitManageRecord === record &&
                this.gitManageRecordKey === storageKey &&
                record.phase === 'queued'
            ) {
                if (
                    error instanceof GitManageHTTPError &&
                    [401, 403, 404].includes(error.status)
                ) {
                    record.phase = 'blocked';
                    record.status =
                        error.status === 401
                            ? 'Phi authorization required. Unlock or reload, then refresh the Git target.'
                            : `Git target check rejected (HTTP ${error.status}). Refresh before trying again.`;
                    this.writeGitManageAction(storageKey, record);
                    this.gitManageStatus = record.status;
                    this.gitManageBusy = false;
                    this.renderGitManagement();
                } else {
                    this.scheduleGitManageRetry(context, record, storageKey);
                }
            }
        } finally {
            if (this.isCurrentGitManageContext(context)) {
                this.gitManageBusy = false;
                this.renderGitManagement();
            }
        }
    }

    private refreshAfterGitAction(context: GitManageRequestContext): void {
        if (!this.isCurrentGitManageContext(context)) return;
        void this.refreshDiff();
        if (this.diffModal && !this.diffModal.classList.contains('hidden')) {
            void this.loadRichDiff();
        }
    }

    private finishGitAction(
        context: GitManageRequestContext,
        record: GitManageActionRecord,
        storageKey: string,
        phase: GitManageActionPhase,
        status: string,
    ): void {
        record.phase = phase;
        record.status = status;
        this.writeGitManageAction(storageKey, record);
        if (!this.isCurrentGitManageContext(context)) return;
        this.clearGitManageRetry();
        this.gitManageRetryDelay = 1000;
        this.gitManageRecord = record;
        this.gitManageStatus = status;
        this.gitManageBusy = false;
        this.renderGitManagement();
    }

    async resumeGitAction(): Promise<void> {
        const context = this.captureGitManageContext();
        const record = this.gitManageRecord;
        if (
            !context.requestAvailable ||
            !record ||
            !['queued', 'paused'].includes(record.phase)
        ) {
            return;
        }
        this.clearGitManageRetry();
        this.gitManageRetryDelay = 1000;
        const claimed: GitManageActionRecord = {
            ...record,
            owner: this.gitManagePageId,
            phase: 'queued',
            status: `Preparing ${gitManageActionLabel(record.action)}…`,
        };
        if (
            !this.claimGitManageAction(this.gitManageRecordKey, record, claimed)
        ) {
            record.phase = 'paused';
            record.status = 'Git action is no longer available to resume here.';
            this.gitManageStatus = record.status;
            this.renderGitManagement();
            return;
        }
        Object.assign(record, claimed);
        this.gitManageBusy = true;
        this.gitManageStatus = record.status;
        this.renderGitManagement();
        await this.dispatchGitAction(context, record, this.gitManageRecordKey);
    }

    cancelGitAction(): void {
        const context = this.captureGitManageContext();
        const record = this.gitManageRecord;
        if (!record || !['queued', 'paused'].includes(record.phase)) return;
        this.clearGitManageRetry();
        this.gitManageRetryDelay = 1000;
        try {
            const stored = JSON.parse(
                localStorage.getItem(this.gitManageRecordKey) || 'null',
            );
            if (
                stored !== null &&
                (stored?.id !== record.id ||
                    stored?.owner !== record.owner ||
                    !['queued', 'paused'].includes(stored?.phase))
            ) {
                this.gitManageStatus =
                    'Git action ownership changed; it was not cancelled.';
                this.renderGitManagement();
                return;
            }
            localStorage.removeItem(this.gitManageRecordKey);
        } catch {
            this.gitManageStatus =
                'Git action could not be cancelled because browser storage is unavailable.';
            this.renderGitManagement();
            return;
        }
        this.gitManageRecord = null;
        this.gitManageRecordKey = '';
        this.gitManageBusy = false;
        this.gitManageStatus = 'Unsent Git action cancelled.';
        if (this.isCurrentGitManageContext(context)) this.renderGitManagement();
    }

    dismissGitAction(): void {
        const context = this.captureGitManageContext();
        const record = this.gitManageRecord;
        if (!record || record.phase !== 'unconfirmed') return;
        try {
            localStorage.setItem(
                `${context.key}:dismissed:${encodeURIComponent(record.id)}`,
                '1',
            );
        } catch {
            /* Acknowledgement remains local to this page. */
        }
        this.gitManageRecord = null;
        this.gitManageRecordKey = '';
        this.gitManageStatus =
            'Unconfirmed result acknowledged. Inspect Git before another action.';
        this.renderGitManagement();
    }

    async openCommitDiff(hash: string, modal = false): Promise<void> {
        if (!/^[0-9a-f]{4,64}$/i.test(hash)) {
            throw new Error('Invalid Git commit hash');
        }
        if (!this.commitSelect)
            throw new Error('Commit selector is unavailable');
        const cwd = this.app.sessionsManager.activeCWD || '';
        this.syncCommitTarget = { hash, cwd };
        this._ensureCommitOption(hash);
        this.activeTab = 'diff';
        document
            .querySelector('.diff-tab-btn.active')
            ?.classList.remove('active');
        document
            .querySelector('.diff-tab-btn[data-tab="diff"]')
            ?.classList.add('active');
        if (!this.isPanelOpen) this.togglePanel(true);
        this._setPanel('git');
        const refresh = this.refreshDiff(true);
        // The selector is set before either fetch. Never open the user's
        // previously selected commit (or silently default to unstaged).
        if (modal) await this.openRichDiffModal();
        await refresh;
    }

    /**
     * Backend switch (embedded single-tab mode). The panel's DOM
     * persists across an in-page switch, but every tab's data is
     * backend-scoped. This runs in the switch's synchronous paint
     * phase: it kills the old backend's stream, resets the commit
     * selector, and repaints the visible tab from the new backend's
     * cached store. It must not fetch — headerless fetches route by
     * the ACTIVE backend, which still points at the old profile until
     * the /__phi/active POST lands. The live refresh happens in
     * refreshDiff after that POST.
     */
    onBackendSwitch(): void {
        if (this.gitManageRecord?.phase === 'queued') {
            this.gitManageRecord.phase = 'paused';
            this.gitManageRecord.status =
                'Queued Git action paused. Resume to verify before sending.';
            this.writeGitManageAction(
                this.gitManageRecordKey,
                this.gitManageRecord,
            );
        }
        this.clearGitManageRetry();
        this.gitManageGeneration++;
        for (const cancel of this.gitManageCancels) {
            cancel('Backend scope changed');
        }
        this.gitManageCancels.clear();
        this.gitManageContextKey = '';
        this.gitManageInfoKey = '';
        this.gitManageInfo = null;
        this.gitManageRecord = null;
        this.gitManageRecordKey = '';
        this.gitManageRequestKey = '';
        this.gitManageBusy = false;
        this.gitManageStatus = 'No cached Git information';
        this.renderGitManagement();
        // Invalidate any old diff fetch before it can paint into this
        // shared panel after the backend changes.
        this._diffStreamToken = (this._diffStreamToken || 0) + 1;
        this._richDiffRequestToken = (this._richDiffRequestToken || 0) + 1;
        this._switchMarkdownCachePainted = false;
        this.closeRichDiffModal();
        this.diffModalBody?.replaceChildren();
        this.lastRawDiffText = '';
        this.activeDiffRoot = null;
        // The old backend's diff stream keeps writing into the shared
        // term (and holds a socket open) until it is closed here.
        if (this.currentWs) {
            try {
                this.currentWs.close();
            } catch {
                /* already closed */
            }
            this.currentWs = null;
        }
        this._resetCommitSelect();
        // Reset even while the panel is hidden: opening it immediately
        // after the switch must not flash the previous backend's DOM.
        if (this.activeTab === 'markdown') {
            this._setPanel('markdown');
            this._switchMarkdownCachePainted =
                this.app.markdownManager?.paintFromStore?.() === true;
        } else if (this.activeTab === 'cmd') {
            this._setPanel('cmd');
            this.renderCmdPanel();
        } else if (this.activeTab === 'files') {
            this._setPanel('files');
            this.app.fileTreeManager?.resetForBackendSwitch?.();
        } else if (this.activeTab === 'sync') {
            // Cached paint already rendered the store's messages; the
            // sync poller refreshes behind the switch.
        } else {
            this._setPanel('git');
            if (this.term) {
                this.term.clear();
                this.term.write(
                    '\x1b[90mBackend switched — refreshing…\x1b[0m\r\n',
                );
            }
        }
    }

    /** The commit list belongs to the old backend's repo; keep only the
     *  cwd-relative defaults a fresh load would start from. */
    _resetCommitSelect(): void {
        if (!this.commitSelect) return;
        const unstagedOpt = document.createElement('option');
        unstagedOpt.value = 'unstaged';
        unstagedOpt.textContent = 'Unstaged Changes';
        const stagedOpt = document.createElement('option');
        stagedOpt.value = 'staged';
        stagedOpt.textContent = 'Staged Changes';
        this._commitLoadToken = (this._commitLoadToken || 0) + 1;
        this.commitSelect.replaceChildren(unstagedOpt, stagedOpt);
        this.commitSelect.value = 'unstaged';
        this._syncModalCommitSelect();
        this.syncCommitTarget = null;
    }

    async loadCommits(): Promise<void> {
        if (!this.commitSelect) return;
        this._commitLoadToken = (this._commitLoadToken || 0) + 1;
        const requestToken = this._commitLoadToken;
        const cwd = this.app.sessionsManager.activeCWD || '';
        const context = this.captureGitManageContext();
        const cached = this.readGitViewCache(
            context,
            this.gitViewRoot(context),
            'commits',
            'recent',
        );
        const applyCommits = (commits: any[], refreshOnFallback: boolean) => {
            if (
                requestToken !== this._commitLoadToken ||
                !this.isCurrentGitManageContext(context) ||
                (this.app.sessionsManager.activeCWD || '') !== cwd
            ) {
                return;
            }
            let currentSelected = this.commitSelect?.value || 'unstaged';
            const target = this.syncCommitTarget;
            if (target && target.cwd !== cwd) {
                if (currentSelected === target.hash)
                    currentSelected = 'unstaged';
                this.syncCommitTarget = null;
            }

            const unstagedOpt = document.createElement('option');
            unstagedOpt.value = 'unstaged';
            unstagedOpt.textContent = 'Unstaged Changes';
            const stagedOpt = document.createElement('option');
            stagedOpt.value = 'staged';
            stagedOpt.textContent = 'Staged Changes';
            this.commitSelect?.replaceChildren(unstagedOpt, stagedOpt);
            commits.forEach((commit: any) => {
                const opt = document.createElement('option');
                opt.value = commit.hash;
                opt.textContent = `${commit.hash} - ${commit.subject}`;
                this.commitSelect?.appendChild(opt);
            });

            const previousSelection = currentSelected;
            if (
                this.syncCommitTarget?.cwd === cwd &&
                this.syncCommitTarget?.hash === currentSelected
            ) {
                this._ensureCommitOption(currentSelected);
            } else if (
                Array.from(this.commitSelect?.options || []).some(
                    (option) => option.value === currentSelected,
                )
            ) {
                if (this.commitSelect)
                    this.commitSelect.value = currentSelected;
            } else if (this.commitSelect) {
                this.commitSelect.value = 'unstaged';
            }
            this._syncModalCommitSelect();
            if (
                refreshOnFallback &&
                previousSelection !== 'unstaged' &&
                this.commitSelect?.value === 'unstaged' &&
                this.activeTab === 'diff' &&
                this.isPanelOpen
            ) {
                void this.refreshDiff(true, { silent: true });
            }
        };

        if (cached) {
            try {
                const commits = JSON.parse(cached.text);
                if (Array.isArray(commits)) applyCommits(commits, false);
            } catch {
                /* A corrupt view cache does not replace the live list. */
            }
        }

        try {
            const commits = await this.requestGitManage(
                context,
                `/api/git/commits?cwd=${encodeURIComponent(cwd)}`,
                { method: 'GET', cache: 'no-store' },
                GIT_INFO_TIMEOUT_MS,
                async (response) => {
                    if (!response.ok)
                        throw new GitManageHTTPError(
                            response.status,
                            await response.text(),
                        );
                    return response.json();
                },
            );
            if (!Array.isArray(commits))
                throw new Error('Invalid Git commit list');
            if (
                requestToken !== this._commitLoadToken ||
                !this.isCurrentGitManageContext(context)
            ) {
                return;
            }
            this.cacheGitView(
                context,
                this.gitViewRoot(context),
                'commits',
                'recent',
                JSON.stringify(commits),
            );
            applyCommits(commits, true);
        } catch {
            // Keep the last saved list and the current selection on read failure.
        }
    }

    _closeCommandContextMenu(): void {
        this.commandContextMenuAbort?.abort();
        this.commandContextMenuAbort = null;
        const menu = document.getElementById('cmd-context-menu');
        if (menu) menu.remove();
    }

    _openCommandContextMenu(cmd: any, event: MouseEvent): void {
        event.preventDefault();
        event.stopPropagation();
        this._closeCommandContextMenu();

        const listenerController = new AbortController();
        this.commandContextMenuAbort = listenerController;

        const menu = document.createElement('div');
        menu.id = 'cmd-context-menu';
        menu.className = 'cmd-context-menu';
        menu.setAttribute('role', 'menu');
        menu.setAttribute('aria-label', `Batch actions for ${cmd.name}`);

        const addItem = (label: string, scope: 'dirty' | 'all'): void => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className =
                'btn btn-primary btn-compact btn-menu cmd-context-menu-item';
            item.dataset.scope = scope;
            item.setAttribute('role', 'menuitem');
            item.textContent = label;
            item.addEventListener('click', () => {
                this._closeCommandContextMenu();
                void this.runCommand(cmd, scope);
            });
            menu.appendChild(item);
        };

        addItem('⚡ Dirty', 'dirty');
        addItem('⇉ All', 'all');
        document.body.appendChild(menu);

        const viewportWidth =
            window.innerWidth || document.documentElement.clientWidth;
        const viewportHeight =
            window.innerHeight || document.documentElement.clientHeight;
        const rect = menu.getBoundingClientRect();
        const x = Number.isFinite(event.clientX) ? event.clientX : 8;
        const y = Number.isFinite(event.clientY) ? event.clientY : 8;
        const maxLeft = Math.max(8, viewportWidth - rect.width - 8);
        const maxTop = Math.max(8, viewportHeight - rect.height - 8);
        menu.style.left = `${Math.min(Math.max(8, x), maxLeft)}px`;
        menu.style.top = `${Math.min(Math.max(8, y), maxTop)}px`;

        const onDocumentClick = (e: MouseEvent): void => {
            if (!menu.contains(e.target as Node))
                this._closeCommandContextMenu();
        };
        const onKeydown = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') {
                e.preventDefault();
                this._closeCommandContextMenu();
            }
        };
        document.addEventListener('click', onDocumentClick, {
            signal: listenerController.signal,
        });
        document.addEventListener('keydown', onKeydown, {
            signal: listenerController.signal,
        });
        menu.querySelector('button')?.focus({ preventScroll: true });
    }

    renderCmdPanel(): void {
        this._closeCommandContextMenu?.();
        const cmdEl = document.getElementById('cmd-panel');
        if (!cmdEl) return;
        cmdEl.innerHTML = '';

        // 1. Create toolbar
        const toolbar = document.createElement('div');
        toolbar.className = 'cmd-toolbar';

        const addBtn = document.createElement('button');
        addBtn.innerHTML = `
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 12px; height: 12px;"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
            Add Command
        `;
        addBtn.addEventListener('click', () => this.addCommand());
        toolbar.appendChild(addBtn);

        const copyAllBtn = document.createElement('button');
        copyAllBtn.innerHTML = `
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 12px; height: 12px;"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            <span>Copy Commands</span>
        `;
        copyAllBtn.addEventListener('click', () =>
            this.copyAllCommands(copyAllBtn),
        );
        toolbar.appendChild(copyAllBtn);

        const pasteListBtn = document.createElement('button');
        pasteListBtn.innerHTML = `
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 12px; height: 12px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
            <span>Paste Config</span>
        `;
        pasteListBtn.addEventListener('click', () =>
            this.pasteCommands(pasteListBtn),
        );
        toolbar.appendChild(pasteListBtn);

        cmdEl.appendChild(toolbar);

        // 1b. Routing toggles container
        const togglesContainer = document.createElement('div');
        togglesContainer.className = 'cmd-toggles-container';

        // Use-separate-hidden-terminal toggle
        const hiddenRow = document.createElement('label');
        hiddenRow.className = 'cmd-reuse-row';
        hiddenRow.title =
            'When on, terminal commands run in a background hidden terminal without creating or switching tabs.';
        const hiddenCheckbox = document.createElement('input');
        hiddenCheckbox.type = 'checkbox';
        hiddenCheckbox.id = 'use-hidden-terminal-toggle';
        hiddenCheckbox.checked = !!(this.app as any).useHiddenTerminal;

        // Reuse-existing-terminal-tab toggle
        const reuseRow = document.createElement('label');
        reuseRow.className = 'cmd-reuse-row';
        reuseRow.title =
            'When on, terminal commands route to the first alive shell tab instead of always spawning a new one.';
        const reuseCheckbox = document.createElement('input');
        reuseCheckbox.type = 'checkbox';
        reuseCheckbox.id = 'use-existing-terminal-tab-toggle';
        reuseCheckbox.checked = !!(this.app as any).useExistingTerminalTab;

        const updateReuseState = () => {
            const isHidden = hiddenCheckbox.checked;
            reuseCheckbox.disabled = isHidden;
            if (isHidden) {
                reuseRow.classList.add('disabled');
            } else {
                reuseRow.classList.remove('disabled');
            }
        };
        updateReuseState();

        hiddenCheckbox.addEventListener('change', async (e) => {
            const target = e.target as HTMLInputElement;
            const enabled = target.checked;
            updateReuseState();
            try {
                await fetch('/api/config/use-hidden-terminal', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled }),
                });
                (this.app as any).useHiddenTerminal = enabled;
                this.app.showToast(
                    enabled
                        ? 'Will use separate hidden terminal'
                        : 'Will use visible terminal tabs',
                    { type: 'info', title: 'Terminal routing' },
                );
            } catch (_err) {
                this.app.showToast('Failed to save preference', {
                    type: 'error',
                    title: 'Terminal routing',
                });
                target.checked = !enabled;
                updateReuseState();
            }
        });

        reuseCheckbox.addEventListener('change', async (e) => {
            const target = e.target as HTMLInputElement;
            const enabled = target.checked;
            try {
                await fetch('/api/config/use-existing-terminal-tab', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled }),
                });
                (this.app as any).useExistingTerminalTab = enabled;
                this.app.showToast(
                    enabled
                        ? 'Will reuse existing terminal tab'
                        : 'Will always open new terminal tab',
                    { type: 'info', title: 'Terminal routing' },
                );
            } catch (_err) {
                this.app.showToast('Failed to save preference', {
                    type: 'error',
                    title: 'Terminal routing',
                });
                target.checked = !enabled;
            }
        });

        const hiddenText = document.createElement('span');
        hiddenText.textContent = 'Use separate hidden terminal';
        hiddenRow.appendChild(hiddenCheckbox);
        hiddenRow.appendChild(hiddenText);
        togglesContainer.appendChild(hiddenRow);

        const reuseText = document.createElement('span');
        reuseText.textContent = 'Reuse existing terminal tab';
        reuseRow.appendChild(reuseCheckbox);
        reuseRow.appendChild(reuseText);
        togglesContainer.appendChild(reuseRow);

        cmdEl.appendChild(togglesContainer);

        // 2. Create list
        const listContainer = document.createElement('div');
        listContainer.className = 'cmd-list';

        const terminalCmds = (this.app as any).terminalCommands || [];
        if (terminalCmds.length === 0) {
            const emptyHint = document.createElement('div');
            emptyHint.style.color = 'var(--text-muted)';
            emptyHint.style.fontSize = '12px';
            emptyHint.style.padding = '12px 4px';
            emptyHint.textContent = 'No terminal commands configured.';
            listContainer.appendChild(emptyHint);
        } else {
            terminalCmds.forEach((cmd: any) => {
                const item = document.createElement('div');
                item.className = 'cmd-item';

                const left = document.createElement('div');
                left.className = 'cmd-item-left';

                const buttonsGroup = document.createElement('div');
                buttonsGroup.className = 'cmd-item-buttons';

                const runBtn = document.createElement('button');
                runBtn.className = 'cmd-run-btn';
                runBtn.textContent = `▶ ${cmd.name}`;
                runBtn.title = `Click to run on current worktree: ${cmd.command}`;
                runBtn.addEventListener('click', () =>
                    this.runCommand(cmd, 'current'),
                );
                buttonsGroup.appendChild(runBtn);

                left.appendChild(buttonsGroup);

                const val = document.createElement('div');
                val.className = 'cmd-val';
                val.textContent = cmd.command;
                val.title = cmd.command;
                left.appendChild(val);

                item.appendChild(left);
                item.addEventListener('contextmenu', (e) => {
                    const target = e.target as Element | null;
                    if (target?.closest('.cmd-item-actions')) return;
                    this._openCommandContextMenu(cmd, e);
                });

                // Actions
                const actions = document.createElement('div');
                actions.className = 'cmd-item-actions';

                // Copy single
                const copySingleBtn = document.createElement('button');
                copySingleBtn.className = 'cmd-action-btn';
                copySingleBtn.title = 'Copy single JSON';
                copySingleBtn.innerHTML = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 12px; height: 12px;"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
                copySingleBtn.addEventListener('click', () =>
                    this.copySingleCommand(cmd),
                );
                actions.appendChild(copySingleBtn);

                // Edit
                const editBtn = document.createElement('button');
                editBtn.className = 'cmd-action-btn';
                editBtn.title = 'Edit';
                editBtn.innerHTML = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 12px; height: 12px;"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>`;
                editBtn.addEventListener('click', () => this.editCommand(cmd));
                actions.appendChild(editBtn);

                // Delete
                const delBtn = document.createElement('button');
                delBtn.className = 'cmd-action-btn del';
                delBtn.title = 'Delete';
                delBtn.innerHTML = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 12px; height: 12px;"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7 a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>`;
                delBtn.addEventListener('click', () => this.deleteCommand(cmd));
                actions.appendChild(delBtn);

                item.appendChild(actions);
                listContainer.appendChild(item);
            });
        }

        cmdEl.appendChild(listContainer);

        // 3. Batch / hidden execution results container
        if (this.activeBatchResults) {
            const batchResults = document.createElement('div');
            batchResults.className = 'cmd-batch-results';

            const batchHeader = document.createElement('div');
            batchHeader.className = 'cmd-batch-header';
            const headerLabel = document.createElement('span');
            headerLabel.textContent = `⚡ "${this.activeBatchResults.commandName}" · ${this.activeBatchResults.scopeLabel}`;
            batchHeader.appendChild(headerLabel);

            const clearBtn = document.createElement('button');
            clearBtn.className = 'cmd-action-btn';
            clearBtn.title = 'Dismiss results';
            clearBtn.textContent = '✕';
            clearBtn.style.minWidth = '20px';
            clearBtn.style.height = '20px';
            clearBtn.style.padding = '0 4px';
            clearBtn.addEventListener('click', () => {
                this.activeBatchResults = null;
                this.renderCmdPanel();
            });
            batchHeader.appendChild(clearBtn);
            batchResults.appendChild(batchHeader);

            const batchList = document.createElement('div');
            batchList.className = 'cmd-batch-list';

            this.activeBatchResults.worktrees.forEach((item: any) => {
                const itemEl = document.createElement('div');
                itemEl.className = 'cmd-batch-item';

                const rowEl = document.createElement('div');
                rowEl.className = 'cmd-batch-item-row';

                const titleEl = document.createElement('div');
                titleEl.className = 'cmd-batch-item-title';
                const glyphSpan = document.createElement('span');
                glyphSpan.className = 'worktree-glyph';
                glyphSpan.style.color = 'var(--accent-bright)';
                glyphSpan.style.fontSize = '11px';
                glyphSpan.textContent = item.glyph;
                const nameSpan = document.createElement('span');
                nameSpan.textContent = item.name;
                titleEl.appendChild(glyphSpan);
                titleEl.appendChild(document.createTextNode(' '));
                titleEl.appendChild(nameSpan);
                rowEl.appendChild(titleEl);

                const badgeEl = document.createElement('span');
                badgeEl.className = `cmd-batch-badge ${item.status}`;
                if (item.status === 'running') {
                    badgeEl.textContent = '⏳ running...';
                } else if (item.status === 'success') {
                    badgeEl.textContent = `✓ ${item.durationMs ?? 0}ms`;
                } else {
                    badgeEl.textContent = `✖ exit ${item.exitCode ?? 1}`;
                }
                rowEl.appendChild(badgeEl);
                itemEl.appendChild(rowEl);

                if (item.output || item.error) {
                    const outputEl = document.createElement('pre');
                    outputEl.className = 'cmd-batch-output hidden';
                    outputEl.textContent = item.output || item.error || '';
                    itemEl.appendChild(outputEl);

                    itemEl.addEventListener('click', () => {
                        outputEl.classList.toggle('hidden');
                    });
                }

                batchList.appendChild(itemEl);
            });

            batchResults.appendChild(batchList);
            cmdEl.appendChild(batchResults);
        }
    }

    async addCommand(): Promise<void> {
        const values = await (this.app as any).openConfigEditor({
            title: 'Add Terminal Command',
            subtitle:
                'Terminal commands run from the cmd panel. Use {} as a placeholder for selected input text.',
            fields: [
                {
                    id: 'name',
                    label: 'Label',
                    placeholder: 'tests',
                    monospace: false,
                },
                {
                    id: 'command',
                    label: 'Command',
                    placeholder: 'npm test',
                    multiline: true,
                },
            ],
            submitLabel: 'Add Command',
        });
        if (!values) return;

        try {
            const res = await fetch('/api/config/terminal-commands', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: values.name,
                    command: values.command,
                }),
            });
            if (!res.ok)
                throw new Error((await res.text()) || 'Failed to add command');

            await this.app.sessionsManager.loadConfig();
            this.renderCmdPanel();
            this.app.showToast(`Added terminal command "${values.name}"`, {
                type: 'info',
                title: 'Commands',
            });
        } catch (e) {
            console.error('Add command failed:', e);
            this.app.showToast((e as Error).message, {
                type: 'error',
                title: 'Commands',
            });
        }
    }

    async editCommand(cmd: any): Promise<void> {
        const values = await (this.app as any).openConfigEditor({
            title: 'Edit Terminal Command',
            subtitle:
                'Rename the action or change the command sent to the shell.',
            fields: [
                {
                    id: 'name',
                    label: 'Label',
                    value: cmd.name,
                    monospace: false,
                },
                {
                    id: 'command',
                    label: 'Command',
                    value: cmd.command,
                    multiline: true,
                },
            ],
            submitLabel: 'Save Command',
        });
        if (
            !values ||
            (values.name === cmd.name && values.command === cmd.command)
        )
            return;

        try {
            const res = await fetch('/api/config/terminal-commands', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    old_name: cmd.name,
                    name: values.name,
                    command: values.command,
                }),
            });
            if (!res.ok)
                throw new Error((await res.text()) || 'Failed to save command');

            await this.app.sessionsManager.loadConfig();
            this.renderCmdPanel();
            this.app.showToast(`Updated terminal command "${values.name}"`, {
                type: 'info',
                title: 'Commands',
            });
        } catch (e) {
            console.error('Edit command failed:', e);
            this.app.showToast((e as Error).message, {
                type: 'error',
                title: 'Commands',
            });
        }
    }

    async deleteCommand(cmd: any): Promise<void> {
        if (!confirm(`Delete terminal command "${cmd.name}"?`)) return;

        try {
            const res = await fetch('/api/config/terminal-commands', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: cmd.name }),
            });
            if (!res.ok)
                throw new Error(
                    (await res.text()) || 'Failed to delete command',
                );

            await this.app.sessionsManager.loadConfig();
            this.renderCmdPanel();
        } catch (e) {
            console.error('Delete command failed:', e);
            alert(`Delete command failed: ${(e as Error).message}`);
        }
    }

    copyAllCommands(btnElement: HTMLElement): void {
        // The cmd panel shows terminal commands (spawn new shell tabs), so the
        // copy button only exports those - not the unrelated quick_commands.
        (this.app as any).exportTerminalCommandsConfig(btnElement);
    }

    copySingleCommand(cmd: any): void {
        const jsonStr = JSON.stringify(cmd, null, 2);
        this.app.tabManager.copyTextRobustly(jsonStr);
    }

    async runCommand(
        cmd: any,
        scope: 'current' | 'dirty' | 'all' = 'current',
    ): Promise<void> {
        if (scope === 'dirty') {
            try {
                const ws = this.app.sessionsManager?.activeWorkspace || '';
                const wtRes = await fetch(
                    `/api/git/worktrees?cwd=${encodeURIComponent(ws)}`,
                );
                const allWts = await wtRes.json();
                const dirtyRes = await fetch(
                    `/api/git/worktree-dirty?cwd=${encodeURIComponent(ws)}`,
                );
                const dirtyMap = await dirtyRes.json();
                const targetWts = (Array.isArray(allWts) ? allWts : []).filter(
                    (wt) => dirtyMap?.[wt.path],
                );
                if (targetWts.length === 0) {
                    this.app.showToast('No dirty worktrees found', {
                        type: 'info',
                        title: 'Batch Command',
                    });
                    return;
                }
                await this.executeHiddenBatch(
                    cmd,
                    targetWts.map((wt) => wt.path),
                    `Dirty Worktrees (${targetWts.length})`,
                );
            } catch (e: any) {
                this.app.showToast(
                    `Failed to scan dirty worktrees: ${e.message}`,
                    { type: 'error', title: 'Batch Command' },
                );
            }
            return;
        }

        if (scope === 'all') {
            try {
                const ws = this.app.sessionsManager?.activeWorkspace || '';
                const wtRes = await fetch(
                    `/api/git/worktrees?cwd=${encodeURIComponent(ws)}`,
                );
                const allWts = await wtRes.json();
                const targetWts =
                    Array.isArray(allWts) && allWts.length > 0
                        ? allWts.map((wt) => wt.path)
                        : [this.app.sessionsManager?.activeCWD || ''];
                await this.executeHiddenBatch(
                    cmd,
                    targetWts,
                    `All Worktrees (${targetWts.length})`,
                );
            } catch (e: any) {
                this.app.showToast(`Failed to scan worktrees: ${e.message}`, {
                    type: 'error',
                    title: 'Batch Command',
                });
            }
            return;
        }

        // scope === 'current'
        if ((this.app as any).useHiddenTerminal) {
            const cwd = this.app.sessionsManager?.activeCWD || '';
            await this.executeHiddenBatch(cmd, [cwd], 'Hidden Terminal');
            return;
        }

        const activeTab = this.app.tabManager.getActiveTab();
        const prefix = this.app.tabManager.inputTextArea.value.trim();
        const combined =
            prefix && cmd.command.includes('{}')
                ? cmd.command.replace('{}', prefix)
                : prefix
                  ? `${prefix} ${cmd.command}`
                  : cmd.command;

        // Consume the prefix now, before any tab switch: switchTab parks
        // the textarea per-tab, so clearing after the switch would wipe
        // the target tab's restored draft and park the consumed prefix
        // on the outgoing tab.
        this.app.tabManager._resetPiRecall?.({ flush: true });
        this.app.tabManager.inputTextArea.value = '';
        this.app.tabManager.lastInputValue = '';
        this.app.tabManager.adjustInputHeight();

        // Decide which tab to send the command to.
        //
        // Scoping rules (important — see bug fixed in commit after 439b3e5):
        //  - Active tab is a shell (bash/pwsh) AND alive → always use it.
        //    The user explicitly focused this tab; trust that.
        //  - Else, if useExistingTerminalTab is on, scan for an alive shell
        //    tab whose CWD matches the CURRENT project's activeCWD. Only an
        //    exact CWD match is reused — never a tab from a different project
        //    or worktree. If no matching tab exists, fall through to spawning
        //    a new shell tab in the current CWD (current behavior).
        //  - Else, spawn new.
        //
        // activeCWD is set by sessionsManager based on the active workspace
        // and active worktree selection, so it correctly scopes by both
        // project AND worktree boundaries in one check.
        const targetTab = findReusableShellTab(
            this.app.tabManager.tabs.values(),
            activeTab,
            {
                useExistingTerminalTab: (this.app as any)
                    .useExistingTerminalTab,
                activeCWD: this.app.sessionsManager.activeCWD || '',
            },
        );
        if (targetTab && targetTab !== activeTab) {
            this.app.tabManager.switchTab(targetTab.paneId);
        }

        if (isUsableShell(targetTab)) {
            let payload = combined;
            if (combined.length > 16 || combined.includes('\n')) {
                payload = `\x1b[200~${combined}\x1b[201~`;
            }
            // Bug fix: previously this used activeTab.ws which meant the
            // command went to whichever tab was focused BEFORE the reuse
            // switch. Must use targetTab so the command lands in the tab
            // we just routed to.
            this.app.tabManager.sendInput(targetTab, `${payload}\r`);
            this.app.tabManager.inputTextArea.focus({ preventScroll: true });
            this.app.tabManager._spamScrollToBottom(targetTab);
        } else {
            // Otherwise, launch a brand new terminal tab running the command!
            try {
                const title = `+ Shell`;
                const cwd = this.app.sessionsManager.activeCWD || '';
                const workspace =
                    this.app.sessionsManager.activeWorkspace || '';

                const res = await fetch('/api/terminals', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        coder: 'bash',
                        cwd: cwd,
                        session_id: '',
                        title: title,
                        workspace: workspace,
                    }),
                });

                if (!res.ok) {
                    const errText = await res
                        .text()
                        .catch(() => 'unknown error');
                    throw new Error(
                        errText.trim() || 'Failed to spawn shell terminal',
                    );
                }

                const data = await res.json();
                this.app.tabManager.createTab(
                    data.pane_id,
                    data.session_id,
                    title,
                    'bash',
                    workspace,
                    cwd,
                    false,
                    false,
                    combined,
                );

                if (this.app.sessionsManager) {
                    this.app.sessionsManager.loadSessions();
                }
            } catch (e) {
                this.app.showToast((e as Error).message, {
                    type: 'error',
                    title: 'Launch Shell',
                });
            }
        }
    }

    async executeHiddenBatch(
        cmd: any,
        worktreePaths: string[],
        scopeLabel: string,
    ): Promise<void> {
        const prefix = this.app.tabManager.inputTextArea.value.trim();
        const combined =
            prefix && cmd.command.includes('{}')
                ? cmd.command.replace('{}', prefix)
                : prefix
                  ? `${prefix} ${cmd.command}`
                  : cmd.command;

        this.app.tabManager._resetPiRecall?.({ flush: true });
        this.app.tabManager.inputTextArea.value = '';
        this.app.tabManager.lastInputValue = '';
        this.app.tabManager.adjustInputHeight();

        this.activeBatchResults = {
            commandName: cmd.name,
            scopeLabel: scopeLabel,
            worktrees: worktreePaths.map((wt) => ({
                path: wt,
                name: getLastFolderName(wt) || wt,
                glyph: worktreeGlyph(wt),
                status: 'running',
            })),
        };
        this.renderCmdPanel();

        try {
            const res = await fetch('/api/cmd/batch-run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    command: combined,
                    worktrees: worktreePaths,
                }),
            });

            if (!res.ok) {
                throw new Error(
                    (await res.text()) || 'Batch command execution failed',
                );
            }

            const data = await res.json();
            const results: any[] = data.results || [];
            if (this.activeBatchResults) {
                results.forEach((r) => {
                    const wtItem = this.activeBatchResults.worktrees.find(
                        (w: any) => w.path === r.worktree,
                    );
                    if (wtItem) {
                        wtItem.status = r.success ? 'success' : 'error';
                        wtItem.exitCode = r.exit_code;
                        wtItem.durationMs = r.duration_ms;
                        wtItem.output = r.output;
                        wtItem.error = r.error;
                    }
                });
            }

            const successCount = results.filter((r) => r.success).length;
            const failCount = results.length - successCount;
            if (failCount === 0) {
                this.app.showToast(
                    `✓ Completed "${cmd.name}" across ${results.length} worktree(s)`,
                    { type: 'success', title: 'Batch Command' },
                );
            } else {
                this.app.showToast(
                    `Completed "${cmd.name}": ${successCount} passed, ${failCount} failed`,
                    { type: 'error', title: 'Batch Command' },
                );
            }
        } catch (err: any) {
            if (this.activeBatchResults) {
                this.activeBatchResults.worktrees.forEach((w: any) => {
                    if (w.status === 'running') {
                        w.status = 'error';
                        w.error = err.message || 'Execution error';
                    }
                });
            }
            this.app.showToast(`Batch execution failed: ${err.message}`, {
                type: 'error',
                title: 'Batch Command',
            });
        } finally {
            if (this.app.sessionsManager?.loadWorktrees) {
                this.app.sessionsManager.loadWorktrees();
            }
            this.renderCmdPanel();
        }
    }

    async pasteCommands(btnElement: HTMLElement): Promise<void> {
        await (this.app as any).importCmdsConfig(btnElement);
        setTimeout(() => this.renderCmdPanel(), 1600);
    }

    async refreshDiff(
        skipLoadCommits: boolean = false,
        opts: { silent?: boolean } = {},
    ): Promise<void> {
        const gitContext = this.captureGitManageContext();
        this.refreshGitManagement(gitContext);
        if (!this.isPanelOpen || !this.term) return;

        this._diffStreamToken = (this._diffStreamToken || 0) + 1;
        const streamToken = this._diffStreamToken;

        if (this.activeTab === 'markdown') {
            this._setPanel('markdown');
            // silent keeps the just-painted cached list on screen; an
            // identical refresh then skips the re-render entirely.
            this.app.markdownManager.refreshFiles({
                force: true,
                silent:
                    opts.silent === true && this._switchMarkdownCachePainted,
            });
            this._switchMarkdownCachePainted = false;
            return;
        }

        if (this.activeTab === 'sync') {
            this._setPanel('sync');
            this.app.syncManager.refreshMessages();
            return;
        }

        if (this.activeTab === 'cmd') {
            this._setPanel('cmd');
            this.renderCmdPanel();
            return;
        }

        if (this.activeTab === 'files') {
            this._setPanel('files');
            this.app.fileTreeManager.refresh();
            return;
        }

        this._setPanel('git');

        // Clean up previous socket
        if (this.currentWs) {
            this.currentWs.close();
            this.currentWs = null;
        }

        const cwd = String(this.app.sessionsManager.activeCWD || '');
        if (this.activeTab === 'diff' && !skipLoadCommits) {
            void this.loadCommits();
        }
        const commitVal = this.commitSelect
            ? this.commitSelect.value
            : 'unstaged';
        const view = this.activeTab;
        const selection = view === 'diff' ? commitVal : 'recent';
        const viewRoot = this.gitViewRoot(gitContext);
        const cachedView = this.readGitViewCache(
            gitContext,
            viewRoot,
            view,
            selection,
        );
        const emptyText =
            view === 'status'
                ? '\x1b[90mClean working tree.\x1b[0m\r\n'
                : view === 'log'
                  ? '\x1b[90mNo commits yet.\x1b[0m\r\n'
                  : '\x1b[90mNo changes detected.\x1b[0m\r\n';
        const paintedCache = this.paintGitViewCache(
            cachedView,
            view,
            emptyText,
        );
        if (!paintedCache) {
            this.term.clear();
            this.term.write('\x1b[35mLoading Git information…\x1b[0m\r\n\r\n');
        }
        if (streamToken !== this._diffStreamToken || !this.isPanelOpen) return;

        // Use a quiet line for the literal non-repository sentinel. Cache the
        // successful answer so a later offline refresh does not revive stale data.
        const notAGitRepo = (label: string, cacheView = false) => {
            if (cacheView) {
                this.cacheGitView(
                    gitContext,
                    viewRoot,
                    view,
                    selection,
                    'NOT_GIT_REPO',
                );
            }
            this._writeStaticTerminalOutput(
                '',
                `\x1b[90mNot a git repository \u2014 ${label} is empty for this workspace.\x1b[0m\r\n`,
            );
        };

        const fetchRaw = (path: string) =>
            this.requestGitManage(
                gitContext,
                path,
                { method: 'GET', cache: 'no-store' },
                GIT_INFO_TIMEOUT_MS,
                async (response) => ({
                    status: response.status,
                    text: await response.text(),
                    head: response.headers.get('X-Phi-Git-Head') || '',
                    branch: response.headers.get('X-Phi-Git-Branch') || '',
                }),
            );

        try {
            if (this.activeTab === 'diff') {
                const result = await fetchRaw(
                    `/api/git/raw-diff?cwd=${encodeURIComponent(cwd)}&commit=${encodeURIComponent(commitVal)}&context=3&ansi=1`,
                );
                if (streamToken !== this._diffStreamToken || !this.isPanelOpen)
                    return;
                if (result.status !== 200)
                    throw new Error(
                        `Git diff refresh failed (HTTP ${result.status}).`,
                    );
                if (result.text === 'NOT_GIT_REPO')
                    return notAGitRepo('the diff', true);
                const head =
                    result.head || this.gitManageInfo?.target?.head || '';
                const branch =
                    result.branch || this.gitManageInfo?.target?.branch || '';
                this.cacheGitView(
                    gitContext,
                    this.gitViewRoot(gitContext),
                    view,
                    selection,
                    result.text,
                    head,
                    branch,
                );
                this._writeStaticTerminalOutput(result.text, emptyText);
                return;
            }

            if (this.activeTab === 'status') {
                const result = await fetchRaw(
                    `/api/git/raw-status?cwd=${encodeURIComponent(cwd)}`,
                );
                if (streamToken !== this._diffStreamToken || !this.isPanelOpen)
                    return;
                if (result.status !== 200)
                    throw new Error(
                        `Git status refresh failed (HTTP ${result.status}).`,
                    );
                if (result.text === 'NOT_GIT_REPO')
                    return notAGitRepo('the status', true);
                this.cacheGitView(
                    gitContext,
                    this.gitViewRoot(gitContext),
                    view,
                    selection,
                    result.text,
                    this.gitManageInfo?.target?.head || '',
                    this.gitManageInfo?.target?.branch || '',
                );
                this._writeStaticTerminalOutput(result.text, emptyText);
                return;
            }

            if (this.activeTab === 'log') {
                const result = await fetchRaw(
                    `/api/git/raw-log?cwd=${encodeURIComponent(cwd)}`,
                );
                if (streamToken !== this._diffStreamToken || !this.isPanelOpen)
                    return;
                if (result.status === 404) {
                    // Older supported servers use the PTY log stream below.
                } else {
                    if (result.status !== 200)
                        throw new Error(
                            `Git log refresh failed (HTTP ${result.status}).`,
                        );
                    if (result.text === 'NOT_GIT_REPO')
                        return notAGitRepo('the log', true);
                    this.cacheGitView(
                        gitContext,
                        this.gitViewRoot(gitContext),
                        view,
                        selection,
                        result.text,
                        result.head || this.gitManageInfo?.target?.head || '',
                        result.branch ||
                            this.gitManageInfo?.target?.branch ||
                            '',
                    );
                    this._writeStaticTerminalOutput(result.text, emptyText);
                    return;
                }
            }

            const data = await this.requestGitManage(
                gitContext,
                `/api/diff?cwd=${encodeURIComponent(cwd)}&type=${this.activeTab}&commit=${commitVal}`,
                { method: 'GET', cache: 'no-store' },
                GIT_INFO_TIMEOUT_MS,
                async (response) => {
                    if (!response.ok)
                        throw new GitManageHTTPError(
                            response.status,
                            await response.text(),
                        );
                    return response.json();
                },
            );

            // A newer refresh (tab switch, worktree switch, second
            // click) owns the panel now. Adopting this socket would
            // overwrite the current view with this one's checkpoint.
            if (streamToken !== this._diffStreamToken || !this.isPanelOpen)
                return;

            // Streaming endpoint signals non-repo via JSON flag rather
            // than by spawning a PTY that immediately exits with the
            // fatal stderr.
            if (data?.notGitRepo) return notAGitRepo('this view', true);

            // Connect and stream diff/log output. The PTY holds output
            // until the checkpoint is rendered and release() runs.
            let streamOutput = '';
            const ws = new PTYWebSocket(
                data.pane_id,
                (text) => {
                    this.term.write(text);
                    if (
                        this.activeTab === 'log' &&
                        streamToken === this._diffStreamToken &&
                        this.isCurrentGitManageContext(gitContext)
                    ) {
                        streamOutput += text;
                        this.cacheGitView(
                            gitContext,
                            this.gitViewRoot(gitContext),
                            'log',
                            'recent',
                            streamOutput,
                            this.gitManageInfo?.target?.head || '',
                            this.gitManageInfo?.target?.branch || '',
                        );
                    }
                },
                null,
                () =>
                    console.log(`[diff] Stream finished for ${this.activeTab}`),
                null,
                {
                    onAttachHead: (info) => {
                        if (this.currentWs !== ws) return;
                        if (!info.ckpt) {
                            if (paintedCache) {
                                this.term.reset();
                                this.term.clear();
                            }
                            this.fitTerminal();
                            ws.release();
                            return;
                        }
                        try {
                            this.term.resize(info.ckpt.cols, info.ckpt.rows);
                        } catch {}
                        const checkpointText = info.ckpt.bytes
                            ? ws.decodeOutput(info.ckpt.bytes)
                            : info.ckpt.ansi;
                        if (paintedCache) {
                            this.term.reset();
                            this.term.clear();
                        }
                        streamOutput = checkpointText;
                        if (
                            this.activeTab === 'log' &&
                            this.isCurrentGitManageContext(gitContext)
                        ) {
                            this.cacheGitView(
                                gitContext,
                                this.gitViewRoot(gitContext),
                                'log',
                                'recent',
                                streamOutput,
                                this.gitManageInfo?.target?.head || '',
                                this.gitManageInfo?.target?.branch || '',
                            );
                        }
                        this.term.write(
                            // Decode through the socket's own decoder: a
                            // checkpoint can end mid-codepoint, and only
                            // the stream decoder carries the split bytes
                            // into the next live frame.
                            checkpointText,
                            () => {
                                if (this.currentWs === ws) this.fitTerminal();
                            },
                        );
                        ws.release();
                    },
                },
            );
            this.currentWs = ws;
            // Fit now: geometry must not depend on the attach frame.
            // The checkpoint resize above corrects it when it arrives.
            this.fitTerminal();
        } catch (e) {
            if (streamToken !== this._diffStreamToken || !this.isPanelOpen)
                return;
            this.term.write(
                `\x1b[31mFailed to load: ${(e as Error).message}\x1b[0m\r\n`,
            );
        }
    }

    async openRichDiffModal(): Promise<void> {
        if (this.diffModal) {
            this.diffModal.classList.remove('hidden');
            void this.loadCommits();
            this._syncModalCommitSelect();
            if (this.contextToggleBtn) {
                this.contextToggleBtn.textContent =
                    this.currentContextLines === 3
                        ? 'More context'
                        : 'Less context';
            }
            this._updateSyntaxToggleBtn();
            await this.loadRichDiff();
        }
    }

    closeRichDiffModal(): void {
        if (this.diffModal) {
            this.diffModal.classList.add('hidden');
        }
    }

    toggleRichDiffSize(): void {
        const content = this.diffModal?.querySelector('.md-modal-content');
        if (!content || !this.modalSizeToggleBtn) return;
        const maximized = content.classList.toggle('diff-modal-maximized');
        this.modalSizeToggleBtn.setAttribute('aria-pressed', String(maximized));
        const label = maximized
            ? 'Restore diff viewer size'
            : 'Maximize diff viewer';
        this.modalSizeToggleBtn.title = label;
        this.modalSizeToggleBtn.setAttribute('aria-label', label);
    }

    async toggleRichDiffContext(): Promise<void> {
        this.currentContextLines = this.currentContextLines === 3 ? 30 : 3;
        if (this.contextToggleBtn) {
            this.contextToggleBtn.textContent =
                this.currentContextLines === 3
                    ? 'More context'
                    : 'Less context';
        }
        await this.loadRichDiff();
    }

    toggleRichDiffLayout(): void {
        if (isDiffDrawerViewport()) return;
        this.currentLayout =
            this.currentLayout === 'line-by-line'
                ? 'side-by-side'
                : 'line-by-line';
        if (this.layoutToggleBtn) {
            this.layoutToggleBtn.textContent =
                this.currentLayout === 'line-by-line'
                    ? 'Side-by-Side'
                    : 'Unified';
        }
        this.renderRichDiff(this.lastRawDiffText);
    }

    toggleRichDiffSyntax(): void {
        this.syntaxHighlightEnabled = !this.syntaxHighlightEnabled;
        try {
            localStorage.setItem(
                'phi_diff_syntax_highlight',
                String(this.syntaxHighlightEnabled),
            );
        } catch {
            /* quota / private-mode failures are non-fatal */
        }
        this._updateSyntaxToggleBtn();
        if (this.syntaxHighlightEnabled) {
            this._applySyntaxHighlighting();
        } else {
            this.renderRichDiff(this.lastRawDiffText);
        }
    }

    _updateSyntaxToggleBtn(): void {
        if (!this.syntaxToggleBtn) return;
        if (this.syntaxHighlightEnabled) {
            this.syntaxToggleBtn.textContent = 'Syntax Off';
            this.syntaxToggleBtn.classList.add('active');
            this.syntaxToggleBtn.title = 'Turn off syntax highlighting';
        } else {
            this.syntaxToggleBtn.textContent = 'Syntax On';
            this.syntaxToggleBtn.classList.remove('active');
            this.syntaxToggleBtn.title = 'Turn on syntax highlighting';
        }
    }

    _applySyntaxHighlighting(): void {
        const hljs = window.hljs;
        if (!hljs || !this.diffModalBody) return;

        const allCodeLines =
            this.diffModalBody.querySelectorAll<HTMLElement>(
                '.d2h-code-line-ctn',
            );
        if (allCodeLines.length === 0) return;

        // Cap at 10,000 lines max to prevent locking the browser thread
        if (allCodeLines.length > 10000) {
            this.app.showToast(
                `Diff has ${allCodeLines.length.toLocaleString()} lines (max 10,000 for syntax highlighting); highlighting skipped.`,
                { type: 'info' },
            );
            this.syntaxHighlightEnabled = false;
            this._updateSyntaxToggleBtn();
            return;
        }

        const fileWrappers =
            this.diffModalBody.querySelectorAll<HTMLElement>(
                '.d2h-file-wrapper',
            );

        fileWrappers.forEach((file) => {
            const rawLang = (
                file.getAttribute('data-lang') || ''
            ).toLowerCase();
            const fileName =
                file.querySelector('.d2h-file-name')?.textContent?.trim() || '';

            // Skip known lockfiles and minified assets
            if (
                /(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|go\.sum|cargo\.lock|\.min\.js|\.min\.css)$/i.test(
                    fileName,
                )
            ) {
                return;
            }

            const extMatch = fileName.match(/\.([a-zA-Z0-9_-]+)$/);
            const ext = extMatch ? extMatch[1].toLowerCase() : rawLang;

            const resolvedLang =
                DIFF_EXT_TO_HLJS[ext] ||
                DIFF_EXT_TO_HLJS[rawLang] ||
                rawLang ||
                'plaintext';

            if (!hljs.getLanguage(resolvedLang)) {
                return;
            }

            const codeLines =
                file.querySelectorAll<HTMLElement>('.d2h-code-line-ctn');

            codeLines.forEach((line) => {
                if (line.classList.contains('hljs')) return;

                const text = line.textContent;
                if (!text || text.length > 1000) return;

                let hlValue = '';
                try {
                    const res = hljs.highlight(text, {
                        language: resolvedLang,
                        ignoreIllegals: true,
                    });
                    hlValue = res.value;
                } catch {
                    return;
                }

                if (line.children.length === 0) {
                    line.innerHTML = hlValue;
                } else {
                    try {
                        const origStream = nodeStream(line);
                        const tempDiv = document.createElement('div');
                        tempDiv.innerHTML = hlValue;
                        const hlStream = nodeStream(tempDiv);
                        line.innerHTML = mergeStreams(
                            origStream,
                            hlStream,
                            text,
                        );
                    } catch {
                        return;
                    }
                }
                line.classList.add('hljs');
            });
        });
    }

    renderRichDiff(rawDiffText: string): void {
        if (!rawDiffText?.trim()) {
            this.diffModalBody!.innerHTML =
                '<div style="padding: 40px; text-align: center; color: var(--text-muted); font-family: var(--font-mono);">No changes detected.</div>';
            // The project buttons stay usable with no diff: opening the
            // project root is independent of which commit is selected.
            this._refreshDiffProjectActions();
            return;
        }

        const isDrawer = isDiffDrawerViewport();
        const outputFormat = isDrawer ? 'line-by-line' : this.currentLayout;

        // Parse once with diff2html so we can map rendered file
        // headers / list entries to their parsed file records. Diff2Html
        // can decorate names like "old -> new" (renames) and append
        // binary/quoted decorations; reading those as labels would
        // conflate "where the file is" with "what to render". The
        // parsed records give us the newName / oldName / isDeleted /
        // isBinary flags directly.
        const parsedFiles = (() => {
            try {
                if (typeof window.Diff2Html?.parse !== 'function') return [];
                return window.Diff2Html.parse(rawDiffText) as Array<{
                    newName?: string;
                    oldName?: string;
                    isDeleted?: boolean;
                    isNew?: boolean;
                    isRename?: boolean;
                    isCopy?: boolean;
                    isBinary?: boolean;
                }>;
            } catch {
                return [];
            }
        })();

        const diffHtml = window.Diff2Html.html(rawDiffText, {
            drawFileList: !isDrawer,
            matching: 'lines',
            outputFormat,
            colorScheme: 'dark',
        });

        // diff2html output is third-party HTML built from raw git diff.
        // Sanitize via DOMPurify (strips scripts/iframes/<style>), then
        // adopt the parsed nodes — avoids innerHTML entirely. DOMParser
        // is read-only, so even a missed tag couldn't execute.
        const safeDiffHtml = window.DOMPurify?.sanitize
            ? String(
                  window.Diff2Html.sanitize
                      ? window.Diff2Html.sanitize(diffHtml, {
                            USE_PROFILES: { html: true },
                            FORBID_TAGS: [
                                'script',
                                'style',
                                'iframe',
                                'object',
                                'embed',
                                'form',
                            ],
                        })
                      : window.DOMPurify.sanitize(diffHtml, {
                            USE_PROFILES: { html: true },
                            FORBID_TAGS: [
                                'script',
                                'style',
                                'iframe',
                                'object',
                                'embed',
                                'form',
                            ],
                        }),
              )
            : diffHtml;
        const parsed = new DOMParser().parseFromString(
            safeDiffHtml,
            'text/html',
        );
        this.diffModalBody?.replaceChildren(
            ...Array.from(parsed.body.childNodes),
        );

        if (this.syntaxHighlightEnabled) {
            this._applySyntaxHighlighting();
        }

        // Wire VS Code editor actions into every file header and the
        // optional file list. Must happen AFTER DOMPurify + DOMParser
        // so we never inject a `vscode:` URI into the unsafe source.
        // The rich-diff data comes from a parsed file record, not from
        // .d2h-file-name text — renaming or decoration cannot break
        // the action's identity.
        this._attachDiffVSCodeActions(parsedFiles);

        // After DOM is in place: wire up the per-row + buttons and
        // rehydrate any saved comments. Re-runs on layout toggle so
        // reviewers don't lose their notes when they flip between
        // unified and side-by-side.
        this._ensureReviewActionBar();
        this._attachDiffReviewListeners();
        this._rehydrateReviewOverlays();
        this._updateReviewActionBar();
        this._refreshDiffProjectActions();
    }

    /** Build the per-file VS Code local + remote anchors and slot them
     *  into every `.d2h-file-wrapper` header and (when present) the
     *  `.d2h-files-list` anchor entries. Pairing is by parsed record
     *  order, so a renames display like "a -> b" still gets the right
     *  actions for the destination name. The active snapshot at
     *  accept time is pinned on `this` and reused here — late
     *  renders that didn't re-fetch stay on the same context. */
    _attachDiffVSCodeActions(
        parsedFiles: Array<{
            newName?: string;
            oldName?: string;
            isDeleted?: boolean;
            isNew?: boolean;
            isRename?: boolean;
            isCopy?: boolean;
            isBinary?: boolean;
        }>,
    ): void {
        if (this.vscodeUnsupported) return;
        if (!this.diffModalBody) return;
        const root = this.activeDiffRoot;
        const hostname = this.activeDiffHostname;
        if (!root) return; // no accepted snapshot — never install actions

        // Build the per-file target list. Deleted files get a disabled
        // anchor; renamed files open the destination. Anything that
        // can't be resolved (no newName, traversal, etc.) is omitted.
        const targets = parsedFiles.map((file, i) => {
            const name =
                file.newName || (file.isDeleted ? file.oldName : '') || '';
            const rel = this._normalizeRel(name);
            const isDeleted = !!file.isDeleted;
            return { index: i, rel, name, isDeleted, file };
        });

        const wrappers =
            this.diffModalBody.querySelectorAll<HTMLElement>(
                '.d2h-file-wrapper',
            );
        wrappers.forEach((wrapper, idx) => {
            // Drop any prior wiring so re-renders (layout toggle,
            // context change) don't stack controls.
            wrapper.querySelectorAll('.ft-vscode-row-actions').forEach((n) => {
                n.remove();
            });
            const target = targets[idx];
            if (!target) return;
            const cluster = this._buildDiffVSCodeCluster(
                root,
                target.rel,
                target.isDeleted,
                target.file?.isBinary ?? false,
                hostname,
                'file',
            );
            if (!cluster) return;
            // Slot the cluster after the filename so long names still
            // dominate the layout (CSS positions it to the right).
            const fileName = wrapper.querySelector('.d2h-file-name');
            if (fileName?.parentElement) {
                fileName.parentElement.appendChild(cluster);
            } else {
                wrapper.appendChild(cluster);
            }
        });

        const fileList =
            this.diffModalBody.querySelector<HTMLElement>('.d2h-files-list');
        if (fileList) {
            const entries = fileList.querySelectorAll<HTMLElement>(
                '.d2h-file-list-file',
            );
            // The visible file-list (when present) mirrors parsedFiles
            // in order — use the same indexing scheme.
            entries.forEach((entry, idx) => {
                entry
                    .querySelectorAll('.ft-vscode-row-actions')
                    .forEach((n) => {
                        n.remove();
                    });
                const target = targets[idx];
                if (!target) return;
                const cluster = this._buildDiffVSCodeCluster(
                    root,
                    target.rel,
                    target.isDeleted,
                    target.file?.isBinary ?? false,
                    hostname,
                    'file',
                );
                if (!cluster) return;
                entry.appendChild(cluster);
            });
        }
    }

    /** Normalize a raw Git path coming out of diff2html. The diff header
     *  can prefix names like `a/...` or `b/...`; we strip those. Quoted
     *  names with literal `\n`, `\"` etc. are decoded only for the
     *  comparison's sake — the URI builder encodes whatever bytes are
     *  left verbatim. */
    _normalizeRel(rawName: string): string {
        if (!rawName) return '';
        // diff2html shows `old/new` for renames; take the destination.
        const renamed = rawName.includes(' => ')
            ? rawName.split(' => ').pop() || rawName
            : rawName;
        // Drop a/b prefixes diff2html sometimes leaves when the
        // diff's index line is included in the label.
        let name = renamed.replace(/^[ab]\//, '');
        // Git sometimes escapes C-style: "\t", "\"" — decode those
        // back to the literal character so the URI builder encodes
        // them as `%09` / `%22` consistently.
        name = name.replace(/\\([ntvbrf\\"'])/g, (_, ch) => {
            const map: Record<string, string> = {
                n: '\n',
                t: '\t',
                v: '\v',
                b: '\b',
                r: '\r',
                f: '\f',
                '\\': '\\',
                '"': '"',
                "'": "'",
            };
            return map[ch] ?? ch;
        });
        return name;
    }

    _buildDiffVSCodeCluster(
        root: string,
        rel: string,
        isDeleted: boolean,
        isBinary: boolean,
        hostname: string,
        kind: 'file' | 'folder',
    ): HTMLElement | null {
        if (!rel && !isDeleted) return null;
        const cluster = document.createElement('span');
        cluster.className = 'ft-vscode-row-actions';

        const localURI = !isDeleted ? buildVSCodeURI(root, rel) : null;
        const remoteURI = !isDeleted
            ? buildVSCodeRemoteURI(hostname, {
                  root,
                  relativePath: rel,
                  kind,
              })
            : null;

        const local = document.createElement('a');
        local.className = 'ft-vscode-row-btn ft-vscode-row-local-btn';
        local.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><path d="M9 8l-4 4 4 4"></path><path d="M15 8l4 4-4 4"></path></svg>`;
        local.title = isDeleted
            ? 'File deleted (cannot open in VS Code)'
            : isBinary
              ? `Open ${rel} in VS Code (binary file)`
              : `Open ${rel} in VS Code`;
        local.setAttribute('aria-label', local.title);
        if (localURI) {
            local.setAttribute('href', localURI);
        } else {
            local.setAttribute('aria-disabled', 'true');
        }
        local.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (localURI) window.location.href = localURI;
        });

        const remote = document.createElement('a');
        remote.className = 'ft-vscode-row-btn ft-vscode-row-remote-btn';
        remote.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><path d="M5 12h14"></path><path d="M9 8l-4 4 4 4"></path><path d="M15 8l4 4-4 4"></path></svg>`;
        remote.title = isDeleted
            ? 'File deleted (cannot open in VS Code Remote)'
            : !hostname
              ? 'No Phi hostname available for SSH target'
              : isBinary
                ? `Open ${rel} in VS Code through SSH to ${hostname} (binary file)`
                : `Open ${rel} in VS Code through SSH to ${hostname}`;
        remote.setAttribute('aria-label', remote.title);
        if (remoteURI) {
            remote.setAttribute('href', remoteURI);
        } else {
            remote.setAttribute('aria-disabled', 'true');
        }
        remote.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (remoteURI) window.location.href = remoteURI;
        });

        cluster.appendChild(local);
        cluster.appendChild(remote);
        return cluster;
    }

    async loadRichDiff(): Promise<void> {
        if (!this.diffModalBody) return;

        // Snapshot the active context before the request. Paint the matching
        // local view first, then replace it when the live answer arrives.
        const context = this.captureGitManageContext();
        const cwd = String(this.app.sessionsManager.activeCWD || '');
        const commitVal = this.commitSelect
            ? this.commitSelect.value
            : 'unstaged';
        const selection = `${commitVal}:${this.currentContextLines}`;
        const root = this.gitViewRoot(context);
        const cached = this.readGitViewCache(
            context,
            root,
            'pretty',
            selection,
        );
        const requestRoot = cwd;
        const requestHostname = normalizeHostname(this.app.hostname);
        const requestToken = (this._richDiffRequestToken || 0) + 1;
        this._richDiffRequestToken = requestToken;
        const paint = (rawDiffText: string, head: string, branch: string) => {
            this.activeGitHead = head;
            this.activeGitBranch = branch;
            this.activeDiffRoot = requestRoot;
            this.activeDiffHostname = requestHostname;
            this.lastRawDiffText = rawDiffText;
            this.renderRichDiff(rawDiffText);
        };
        const showCacheNotice = () => {
            const notice = document.createElement('div');
            notice.className = 'git-view-cache-note';
            notice.textContent = 'Refresh failed; showing the last saved diff.';
            this.diffModalBody?.prepend(notice);
        };

        if (cached) paint(cached.text, cached.head, cached.branch);
        else {
            this.diffModalBody.innerHTML =
                '<div style="padding: 20px; color: var(--text-muted); font-family: var(--font-mono); font-size: 13px;">Loading rich diff viewer...</div>';
        }

        try {
            const result = await this.requestGitManage(
                context,
                `/api/git/raw-diff?cwd=${encodeURIComponent(cwd)}&commit=${encodeURIComponent(commitVal)}&context=${this.currentContextLines}`,
                { method: 'GET', cache: 'no-store' },
                GIT_INFO_TIMEOUT_MS,
                async (response) => ({
                    status: response.status,
                    text: await response.text(),
                    head: response.headers.get('X-Phi-Git-Head') || '',
                    branch: response.headers.get('X-Phi-Git-Branch') || '',
                }),
            );
            if (
                requestToken !== this._richDiffRequestToken ||
                !this.isCurrentGitManageContext(context)
            )
                return;
            if (result.status !== 200)
                throw new Error(
                    result.text.trim() ||
                        `Diff refresh failed (HTTP ${result.status}).`,
                );
            this.cacheGitView(
                context,
                this.gitViewRoot(context),
                'pretty',
                selection,
                result.text,
                result.head,
                result.branch,
            );
            paint(result.text, result.head, result.branch);
        } catch (error) {
            if (
                requestToken !== this._richDiffRequestToken ||
                !this.isCurrentGitManageContext(context)
            )
                return;
            if (cached) {
                showCacheNotice();
                return;
            }
            const errDiv = document.createElement('div');
            errDiv.style.padding = '20px';
            errDiv.style.color = 'var(--red)';
            errDiv.style.fontFamily = 'var(--font-mono)';
            errDiv.style.fontSize = '13px';
            errDiv.textContent = `Error: ${(error as Error).message}`;
            this.diffModalBody.replaceChildren(errDiv);
        }
    }

    // ─── Diff review comments ───────────────────────────────────────────
    // The following block lets reviewers attach inline notes to specific
    // diff lines, then compile those notes into a prompt-engineered
    // Markdown summary that lands directly in the active terminal's
    // input bar. Comments persist across layout toggles (unified ↔
    // side-by-side) and survive modal close/reopen via localStorage.

    // Unique key for a (file, line) pair. Including BOTH old and new
    // line numbers disambiguates side-by-side rows (a single change
    // produces two rows: one with old=, one with new=) from the
    // identical-line context rows.
    _reviewKey(info: DiffLineInfo): string {
        return `${info.filePath}:${info.oldLineNumber ?? ''}:${info.newLineNumber ?? ''}`;
    }

    _reviewRowSide(row: HTMLElement): 'old' | 'new' | null {
        const pane = row.closest('.d2h-file-side-diff');
        const panes = pane?.parentElement?.querySelectorAll(
            ':scope > .d2h-file-side-diff',
        );
        if (panes?.length !== 2) return null;
        return pane === panes[0] ? 'old' : 'new';
    }

    _showCommentOnRow(row: HTMLElement, comment: DiffReviewComment): boolean {
        const side = this._reviewRowSide(row);
        return (
            comment.lineType !== 'context' ||
            side === null ||
            side === (comment.displaySide ?? 'new')
        );
    }

    // Older side-by-side drafts stored every line as new-only. Move one
    // onto its actual old/new key when we see that pane again, so a saved
    // deletion or context note isn't lost after this identity fix.
    _migrateLegacySideComment(
        row: HTMLElement,
        info: DiffLineInfo,
    ): DiffReviewComment | undefined {
        const side = this._reviewRowSide(row);
        const line = side === 'old' ? info.oldLineNumber : info.newLineNumber;
        if (!side || line === null) return undefined;
        const oldKey = `${info.filePath}::${line}`;
        const previous = this.reviewComments.get(oldKey);
        if (
            !previous ||
            previous.oldLineNumber !== null ||
            previous.newLineNumber !== line ||
            previous.lineType !== info.lineType
        ) {
            return undefined;
        }
        const comment = {
            ...previous,
            oldLineNumber: info.oldLineNumber,
            newLineNumber: info.newLineNumber,
            displaySide: side,
        };
        this.reviewComments.delete(oldKey);
        this.reviewComments.set(this._reviewKey(info), comment);
        this._saveReviewDraft();
        return comment;
    }

    // Walk up from a row to the nearest .d2h-file-wrapper, read its
    // .d2h-file-name text. Empty string on the unlikely chance diff2html
    // renames the class.
    _rowFilePath(row: HTMLElement): string {
        const wrapper = row.closest('.d2h-file-wrapper') as HTMLElement | null;
        const name = wrapper?.querySelector('.d2h-file-name');
        return name?.textContent?.trim() || '';
    }

    // Read the line number cell. Unified rows have a `.line-num1` +
    // `.line-num2` pair; side-by-side rows have just a single text
    // node. Empty cells (`.d2h-emptyplaceholder`) → null.
    _rowLineNumbers(row: HTMLElement): {
        oldLineNumber: number | null;
        newLineNumber: number | null;
    } {
        const ln = row.querySelector(
            '.d2h-code-linenumber, .d2h-code-side-linenumber',
        );
        if (!ln || ln.classList.contains('d2h-emptyplaceholder')) {
            return { oldLineNumber: null, newLineNumber: null };
        }
        const n1 = row.querySelector('.line-num1');
        const n2 = row.querySelector('.line-num2');
        const parse = (el: Element | null): number | null => {
            if (!el) return null;
            const txt = el.textContent?.trim() || '';
            return txt ? Number(txt) : null;
        };
        // Side-by-side numbers are direct text nodes. Do not include the
        // appended + button's text (or other controls) when re-reading a
        // wired row for comment save / rehydration.
        if (!n1 && !n2) {
            const readSideNumber = (cell: Element | null): number | null => {
                if (!cell) return null;
                const txt = Array.from(cell.childNodes)
                    .filter((node) => node.nodeType === Node.TEXT_NODE)
                    .map((node) => node.textContent || '')
                    .join('')
                    .trim();
                const n = txt ? Number(txt) : null;
                return n !== null && Number.isFinite(n) ? n : null;
            };
            const n = readSideNumber(ln);
            const pane = row.closest('.d2h-file-side-diff');
            const panes = pane?.parentElement?.querySelectorAll(
                ':scope > .d2h-file-side-diff',
            );
            // Standalone rows (e.g. test fixtures) retain the old fallback.
            if (panes?.length !== 2) {
                return { oldLineNumber: null, newLineNumber: n };
            }
            const isOldPane = pane === panes[0];
            if (this._rowLineType(row) === 'context') {
                // Diff2html aligns both tables row-for-row. Ignore our
                // injected editor/card rows when locating the peer line.
                const codeRows = (body: Element | null) =>
                    Array.from(body?.children || []).filter(
                        (el) =>
                            !el.classList.contains('diff-comment-editor-row') &&
                            !el.classList.contains('diff-comment-display-row'),
                    );
                const index = codeRows(row.parentElement).indexOf(row);
                const peerBody =
                    panes[isOldPane ? 1 : 0].querySelector('.d2h-diff-tbody');
                const peerRow = codeRows(peerBody)[index];
                if (
                    peerRow &&
                    this._rowLineType(peerRow as HTMLElement) === 'context'
                ) {
                    const peer = readSideNumber(
                        peerRow.querySelector('.d2h-code-side-linenumber'),
                    );
                    return isOldPane
                        ? { oldLineNumber: n, newLineNumber: peer }
                        : { oldLineNumber: peer, newLineNumber: n };
                }
            }
            return isOldPane
                ? { oldLineNumber: n, newLineNumber: null }
                : { oldLineNumber: null, newLineNumber: n };
        }
        return {
            oldLineNumber: parse(n1),
            newLineNumber: parse(n2),
        };
    }

    _rowLineType(row: HTMLElement): 'insert' | 'delete' | 'context' | null {
        // diff2html tags each row with d2h-ins / d2h-del / d2h-cntx /
        // d2h-info. We only care about the first three.
        for (const cls of ['d2h-ins', 'd2h-del', 'd2h-cntx']) {
            // Match on the row or any descendant (line-number cell +
            // code cell both carry the type class).
            if (row.querySelector(`.${cls}`)) {
                return cls === 'd2h-ins'
                    ? 'insert'
                    : cls === 'd2h-del'
                      ? 'delete'
                      : 'context';
            }
        }
        return null;
    }

    _extractLineInfo(row: HTMLElement): DiffLineInfo | null {
        const lineType = this._rowLineType(row);
        if (!lineType) return null;
        const filePath = this._rowFilePath(row);
        if (!filePath) return null;
        const { oldLineNumber, newLineNumber } = this._rowLineNumbers(row);
        if (oldLineNumber === null && newLineNumber === null) return null;
        return { filePath, oldLineNumber, newLineNumber, lineType };
    }

    // Walk siblings inside the same tbody for the comment's context.
    // Read only source spans: their parent contains HTML-template
    // indentation/newlines, and context markers render as NBSPs.
    _rowCodeSnippet(row: HTMLElement, radius: number = 2): string {
        const tbody = row.parentElement;
        if (!tbody) return '';
        const siblings = Array.from(tbody.children) as HTMLElement[];
        const idx = siblings.indexOf(row);
        if (idx === -1) return '';
        const start = Math.max(0, idx - radius);
        const end = Math.min(siblings.length, idx + radius + 1);
        const lines: string[] = [];
        for (let i = start; i < end; i++) {
            const sib = siblings[i];
            const lineType = this._rowLineType(sib);
            if (!lineType) continue; // skip hunk headers / placeholders
            const code = sib.querySelector('.d2h-code-line-ctn');
            if (!code) continue; // side-by-side empty placeholders
            const prefix =
                lineType === 'insert' ? '+' : lineType === 'delete' ? '-' : ' ';
            // Tabs, trailing spaces, blank lines, and source NBSPs are
            // code, not renderer padding. Preserve them verbatim.
            lines.push(prefix + (code.textContent || ''));
        }
        return lines.join('\n');
    }

    // Older saved drafts captured diff2html's wrapper text. Repair only
    // that exact template structure, not arbitrary code whitespace.
    // Its old trim already lost trailing source whitespace; do not guess
    // at those bytes or replace the saved context with a newer diff.
    _normalizeReviewCodeSnippet(snippet: string): string {
        if (!snippet.startsWith('\n')) return snippet;
        const padding = ' '.repeat(12);
        const lines = snippet.split('\n');
        const source: string[] = [];
        let foundTemplate = false;
        for (let i = 0; i < lines.length; ) {
            if (lines[i] !== '') return snippet;
            const marker = lines[i + 1]?.match(/^ {12}([+\u00a0-])$/);
            if (!marker) {
                // Old trimming collapsed empty context rows to ''.
                source.push(' ');
                i++;
                continue;
            }
            foundTemplate = true;
            const content = lines[i + 2];
            const hasContent = content?.startsWith(padding);
            source.push(
                (marker[1] === '\u00a0' ? ' ' : marker[1]) +
                    (hasContent ? content.slice(padding.length) : ''),
            );
            i += hasContent ? 3 : 2;
        }
        return foundTemplate ? source.join('\n') : snippet;
    }

    _reviewActionBarParent(): HTMLElement | null {
        return this.diffModal?.querySelector('.md-modal-content') || null;
    }

    // Build the floating "X Comments | Clear | Copy | Apply" bar once.
    // Reused on every render — only its counter + visibility update.
    _ensureReviewActionBar(): void {
        if (this.reviewActionBar) return;
        const parent = this._reviewActionBarParent();
        if (!parent) return;
        if (!parent.style.position) {
            // Floating overlay needs a positioned ancestor; the modal
            // content is flex-column but not explicitly positioned.
            parent.style.position = 'relative';
        }

        const bar = document.createElement('div');
        bar.className = 'diff-review-action-bar hidden';
        bar.id = 'diff-review-action-bar';

        const counter = document.createElement('div');
        counter.className = 'diff-review-counter';
        const badge = document.createElement('span');
        badge.className = 'diff-review-count-badge';
        badge.textContent = '0';
        const label = document.createElement('span');
        label.className = 'diff-review-count-label';
        label.textContent = 'Comments';
        counter.append(badge, label);
        bar.appendChild(counter);

        const buttons = document.createElement('div');
        buttons.className = 'diff-review-buttons';

        const clearBtn = document.createElement('button');
        clearBtn.id = 'diff-review-clear-btn';
        clearBtn.className = 'diff-review-btn secondary';
        clearBtn.type = 'button';
        clearBtn.title = 'Discard all comments';
        clearBtn.textContent = 'Clear';
        clearBtn.addEventListener('click', () => this._clearReviewComments());

        const copyBtn = document.createElement('button');
        copyBtn.id = 'diff-review-copy-btn';
        copyBtn.className = 'diff-review-btn secondary';
        copyBtn.type = 'button';
        copyBtn.title = 'Copy review markdown to clipboard';
        copyBtn.textContent = 'Copy Prompt';
        copyBtn.addEventListener('click', () => this._copyReviewPrompt());

        const applyBtn = document.createElement('button');
        applyBtn.id = 'diff-review-apply-btn';
        applyBtn.className = 'diff-review-btn primary';
        applyBtn.type = 'button';
        applyBtn.title =
            'Stage formatted review into terminal prompt (⌘+Shift+Enter)';
        applyBtn.textContent = 'Apply to Prompt';
        applyBtn.addEventListener('click', () =>
            this.applyReviewToTerminalPrompt(),
        );

        buttons.append(clearBtn, copyBtn, applyBtn);
        bar.appendChild(buttons);
        parent.appendChild(bar);
        this.reviewActionBar = bar;
    }

    _updateReviewActionBar(): void {
        if (!this.reviewActionBar) return;
        const count = this.reviewComments.size;
        const badge = this.reviewActionBar.querySelector(
            '.diff-review-count-badge',
        );
        if (badge) badge.textContent = String(count);
        this.reviewActionBar.classList.toggle('hidden', count === 0);
    }

    // Stamp a `+` hover button into the line-number cell of every
    // commentable row. Skips hunk headers and empty placeholders.
    _attachDiffReviewListeners(): void {
        if (!this.diffModalBody) return;
        const rows = this.diffModalBody.querySelectorAll(
            '.d2h-diff-tbody tr',
        ) as NodeListOf<HTMLElement>;
        rows.forEach((row) => {
            // Don't double-attach after re-renders (rehydrate path).
            if (row.dataset.reviewWired === '1') return;
            const info = this._extractLineInfo(row);
            if (!info) return;
            row.dataset.reviewWired = '1';

            const lnCell = row.querySelector(
                '.d2h-code-linenumber, .d2h-code-side-linenumber',
            );
            if (!lnCell) return;

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'diff-add-comment-btn';
            btn.title = 'Add review comment';
            btn.textContent = '+';
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this._openCommentEditor(row, info);
            });
            lnCell.appendChild(btn);
        });
    }

    // Re-render the display row + persistent highlight for every
    // saved comment whose row is in the current DOM. Called after
    // each renderRichDiff so layout toggles don't drop notes.
    _rehydrateReviewOverlays(): void {
        if (!this.diffModalBody) return;
        const rows = Array.from(
            this.diffModalBody.querySelectorAll(
                '.d2h-diff-tbody tr',
            ) as NodeListOf<HTMLElement>,
        );
        rows.forEach((row) => {
            const info = this._extractLineInfo(row);
            if (!info) return;
            const key = this._reviewKey(info);
            const comment =
                this.reviewComments.get(key) ||
                this._migrateLegacySideComment(row, info);
            if (!comment || comment.lineType !== info.lineType) return;
            row.classList.add('d2h-has-comment');
            if (!this._showCommentOnRow(row, comment)) return;
            const next = row.nextElementSibling as HTMLElement | null;
            if (next?.dataset?.reviewDisplayFor === key) return;
            this._renderCommentDisplayRow(row, comment);
        });
    }

    _openCommentEditor(
        row: HTMLElement,
        info: DiffLineInfo,
        existing?: DiffReviewComment,
    ): void {
        // If a display row already sits below, replace it with an
        // editor instead of stacking a new one.
        const next = row.nextElementSibling as HTMLElement | null;
        if (next?.dataset?.reviewDisplayFor === this._reviewKey(info)) {
            next.remove();
        }
        // Drop any in-progress editor so opening twice doesn't stack.
        if (next?.dataset?.reviewEditingFor === this._reviewKey(info)) {
            next.remove();
        }

        const snippet = existing?.codeSnippet
            ? this._normalizeReviewCodeSnippet(existing.codeSnippet)
            : this._rowCodeSnippet(row);

        const editorRow = document.createElement('tr');
        editorRow.className = 'diff-comment-editor-row';
        editorRow.dataset.reviewEditingFor = this._reviewKey(info);

        const cell = document.createElement('td');
        cell.colSpan = 100;
        cell.className = 'diff-comment-editor-cell';

        const box = document.createElement('div');
        box.className = 'diff-comment-editor-box';

        const header = document.createElement('div');
        header.className = 'diff-comment-editor-header';
        const badge = document.createElement('span');
        badge.className = 'diff-comment-target-badge';
        const lineRef = info.newLineNumber ?? info.oldLineNumber ?? '?';
        badge.textContent = `${info.filePath}:${lineRef}`;
        const hint = document.createElement('span');
        hint.className = 'diff-comment-hint';
        hint.textContent = existing
            ? 'Editing comment · ⌘+Enter to save · Esc to cancel'
            : 'New comment · ⌘+Enter to save · Esc to cancel';
        header.append(badge, hint);

        const textarea = document.createElement('textarea');
        textarea.className = 'diff-comment-textarea';
        textarea.placeholder =
            'Explain what to fix or change here (Markdown supported)…';
        textarea.value = existing?.commentText || '';
        textarea.rows = 3;
        textarea.spellcheck = false;

        const actions = document.createElement('div');
        actions.className = 'diff-comment-editor-actions';
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'diff-comment-cancel-btn';
        cancelBtn.textContent = 'Cancel';
        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'diff-comment-save-btn primary';
        saveBtn.textContent = existing ? 'Save Changes' : 'Save Comment';

        cancelBtn.addEventListener('click', () => editorRow.remove());
        saveBtn.addEventListener('click', () => {
            const text = textarea.value.trim();
            if (!text) {
                this.app.showToast?.('Comment cannot be empty', {
                    type: 'error',
                });
                return;
            }
            this._saveComment(info, snippet, text, existing, row);
        });
        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                editorRow.remove();
            } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                saveBtn.click();
            }
        });

        actions.append(cancelBtn, saveBtn);
        box.append(header, textarea, actions);
        cell.appendChild(box);
        editorRow.appendChild(cell);

        row.insertAdjacentElement('afterend', editorRow);
        // Defer focus until after the row is in the DOM so the
        // browser scrolls/positions correctly.
        setTimeout(() => {
            textarea.focus({ preventScroll: false });
            textarea.setSelectionRange(
                textarea.value.length,
                textarea.value.length,
            );
        }, 0);
    }

    _saveComment(
        info: DiffLineInfo,
        snippet: string,
        text: string,
        existing?: DiffReviewComment,
        sourceRow?: HTMLElement,
    ): void {
        const key = this._reviewKey(info);
        const comment: DiffReviewComment = {
            id:
                existing?.id ||
                `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            filePath: info.filePath,
            oldLineNumber: info.oldLineNumber,
            newLineNumber: info.newLineNumber,
            lineType: info.lineType,
            displaySide:
                existing?.displaySide ??
                (sourceRow
                    ? (this._reviewRowSide(sourceRow) ?? undefined)
                    : undefined),
            codeSnippet: snippet,
            commentText: text,
            createdAt: existing?.createdAt || Date.now(),
        };
        this.reviewComments.set(key, comment);

        // Find the original row(s) and refresh display rows / highlights.
        const rows = this.diffModalBody
            ? (Array.from(
                  this.diffModalBody.querySelectorAll('.d2h-diff-tbody tr'),
              ) as HTMLElement[])
            : [];
        rows.forEach((row) => {
            const rowInfo = this._extractLineInfo(row);
            if (!rowInfo || this._reviewKey(rowInfo) !== key) return;
            row.classList.add('d2h-has-comment');
            // Strip any in-flight editor row.
            const next = row.nextElementSibling as HTMLElement | null;
            if (next?.dataset?.reviewEditingFor === key) {
                next.remove();
            }
            // Replace any prior display row for this key with the
            // freshest content (handles edits as well as inserts).
            const old = row.nextElementSibling as HTMLElement | null;
            if (old?.dataset?.reviewDisplayFor === key) {
                old.remove();
            }
            if (this._showCommentOnRow(row, comment)) {
                this._renderCommentDisplayRow(row, comment);
            }
        });

        this._saveReviewDraft();
        this._updateReviewActionBar();
    }

    _renderCommentDisplayRow(
        row: HTMLElement,
        comment: DiffReviewComment,
    ): void {
        const key = this._reviewKey({
            filePath: comment.filePath,
            oldLineNumber: comment.oldLineNumber,
            newLineNumber: comment.newLineNumber,
            lineType: comment.lineType,
        });

        const displayRow = document.createElement('tr');
        displayRow.className = 'diff-comment-display-row';
        displayRow.dataset.reviewDisplayFor = key;

        const cell = document.createElement('td');
        cell.colSpan = 100;
        cell.className = 'diff-comment-display-cell';

        const card = document.createElement('div');
        card.className = `diff-comment-card diff-comment-${comment.lineType}`;

        const head = document.createElement('div');
        head.className = 'diff-comment-card-head';
        const badge = document.createElement('span');
        badge.className = 'diff-comment-target-badge';
        const lineRef = comment.newLineNumber ?? comment.oldLineNumber ?? '?';
        badge.textContent = `${comment.filePath}:${lineRef}`;
        const typeLabel = document.createElement('span');
        typeLabel.className = 'diff-comment-type-label';
        typeLabel.textContent =
            comment.lineType === 'insert'
                ? 'addition'
                : comment.lineType === 'delete'
                  ? 'deletion'
                  : 'context';
        head.append(badge, typeLabel);

        const body = document.createElement('div');
        body.className = 'diff-comment-card-body';
        body.textContent = comment.commentText;

        const actions = document.createElement('div');
        actions.className = 'diff-comment-card-actions';
        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'diff-comment-card-btn';
        editBtn.textContent = 'Edit';
        editBtn.addEventListener('click', () => this._editComment(comment));
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'diff-comment-card-btn danger';
        delBtn.textContent = 'Delete';
        delBtn.addEventListener('click', () => this._deleteComment(comment.id));
        actions.append(editBtn, delBtn);

        card.append(head, body, actions);
        cell.appendChild(card);
        displayRow.appendChild(cell);

        row.insertAdjacentElement('afterend', displayRow);
    }

    _editComment(comment: DiffReviewComment): void {
        const info: DiffLineInfo = {
            filePath: comment.filePath,
            oldLineNumber: comment.oldLineNumber,
            newLineNumber: comment.newLineNumber,
            lineType: comment.lineType,
        };
        const rows = this.diffModalBody
            ? (Array.from(
                  this.diffModalBody.querySelectorAll('.d2h-diff-tbody tr'),
              ) as HTMLElement[])
            : [];
        for (const row of rows) {
            const rowInfo = this._extractLineInfo(row);
            if (
                rowInfo &&
                this._reviewKey(rowInfo) === this._reviewKey(info) &&
                this._showCommentOnRow(row, comment)
            ) {
                this._openCommentEditor(row, info, comment);
                return;
            }
        }
    }

    _deleteComment(id: string): void {
        let removedKey: string | null = null;
        for (const [k, v] of this.reviewComments) {
            if (v.id === id) {
                removedKey = k;
                this.reviewComments.delete(k);
                break;
            }
        }
        if (!removedKey) return;

        // Strip display rows + highlight class on every row with this key.
        const rows = this.diffModalBody
            ? (Array.from(
                  this.diffModalBody.querySelectorAll('.d2h-diff-tbody tr'),
              ) as HTMLElement[])
            : [];
        rows.forEach((row) => {
            const info = this._extractLineInfo(row);
            if (!info) return;
            if (this._reviewKey(info) !== removedKey) return;
            row.classList.remove('d2h-has-comment');
            const next = row.nextElementSibling as HTMLElement | null;
            if (next?.dataset?.reviewDisplayFor === removedKey) {
                next.remove();
            }
        });

        this._saveReviewDraft();
        this._updateReviewActionBar();
    }

    _clearReviewComments(): void {
        if (this.reviewComments.size === 0) return;
        if (
            !confirm(
                `Discard all ${this.reviewComments.size} review comment(s)?`,
            )
        ) {
            return;
        }
        this.reviewComments.clear();
        // Strip display rows + highlight class on every row.
        for (const el of this.diffModalBody?.querySelectorAll(
            '.diff-comment-display-row',
        ) ?? []) {
            el.remove();
        }
        for (const el of this.diffModalBody?.querySelectorAll(
            '.d2h-has-comment',
        ) ?? []) {
            el.classList.remove('d2h-has-comment');
        }
        this._saveReviewDraft();
        this._updateReviewActionBar();
        this.app.showToast?.('Review comments cleared', { type: 'info' });
    }

    // Stable, deterministic ordering so the staged prompt reads
    // top-to-bottom in the same order the reviewer saw them.
    _sortedReviewComments(): DiffReviewComment[] {
        return Array.from(this.reviewComments.values()).sort((a, b) => {
            if (a.filePath !== b.filePath)
                return a.filePath < b.filePath ? -1 : 1;
            const aLine = a.newLineNumber ?? a.oldLineNumber ?? 0;
            const bLine = b.newLineNumber ?? b.oldLineNumber ?? 0;
            if (aLine !== bLine) return aLine - bLine;
            return a.createdAt - b.createdAt;
        });
    }

    _reviewContextHeader(): string {
        const commitVal = this.commitSelect?.value || 'unstaged';
        const workspace =
            getLastFolderName(this.app.sessionsManager?.activeCWD || '') ||
            'workspace';
        if (commitVal === 'unstaged' || commitVal === 'staged') {
            const head = this.activeGitHead || 'unknown';
            const label =
                commitVal === 'staged'
                    ? 'staged changes'
                    : 'unstaged working tree changes';
            return `Below is a code review on ${label} relative to HEAD \`${head}\` in workspace \`${workspace}\`. Read each comment carefully and respond to what the reviewer actually wrote — these notes are heterogeneous (questions, observations, requests, criticisms), and not every comment is a request for a code change.`;
        }
        return `Below is a code review on git revision \`${commitVal}\` in workspace \`${workspace}\`. Read each comment carefully and respond to what the reviewer actually wrote — these notes are heterogeneous (questions, observations, requests, criticisms), and not every comment is a request for a code change.`;
    }

    _buildPromptEngineeredReview(): string {
        const comments = this._sortedReviewComments();
        const header = this._reviewContextHeader();
        const blocks: string[] = [];
        comments.forEach((c, i) => {
            const lineRef = c.newLineNumber ?? c.oldLineNumber ?? '?';
            const lang = c.filePath.split('.').pop() || '';
            const snippet = this._normalizeReviewCodeSnippet(c.codeSnippet)
                .split('\n')
                .map((l) => `> ${l}`)
                .join('\n');
            blocks.push(
                [
                    `#### ${i + 1}. \`${c.filePath}:${lineRef}\``,
                    `> \`\`\`${lang}`,
                    snippet,
                    `> \`\`\``,
                    `**Reviewer said:**`,
                    c.commentText,
                ].join('\n'),
            );
        });
        const tail = [
            '---',
            '### How to respond:',
            '1. For each numbered item above, decide what the reviewer is actually asking for. A comment may be a question ("why X?"), an observation, a suggestion, a criticism, or an explicit request — handle each on its own terms.',
            '2. If the reviewer asked a question, ANSWER it in plain prose. Do not silently rewrite code.',
            '3. If the reviewer made a suggestion, evaluate it on the merits. You may agree and implement it, or disagree and explain why. Do not treat suggestions as orders.',
            '4. If the reviewer requested a code change you consider wrong or destructive, push back and explain the concern rather than complying. Compliance with a bad review is a worse outcome than a missed change.',
            '5. Do not invent code edits the reviewer did not ask for. Do not "fix" things the reviewer was merely curious about.',
            '6. When you do edit code, keep changes scoped to the file and line range cited above; preserve surrounding architecture, style, and comments; verify the build / tests / linters after.',
            '7. If a comment is ambiguous, prefer answering what the reviewer literally asked over guessing an implementation.',
        ].join('\n');
        return [
            header,
            '',
            `### Reviewer comments (${comments.length} item${comments.length === 1 ? '' : 's'})`,
            '',
            blocks.join('\n\n'),
            '',
            tail,
            '',
        ].join('\n');
    }

    _copyReviewPrompt(): void {
        if (this.reviewComments.size === 0) return;
        const md = this._buildPromptEngineeredReview();
        const tm = this.app.tabManager;
        tm?.copyTextRobustly?.(md);
    }

    applyReviewToTerminalPrompt(): void {
        if (this.reviewComments.size === 0) return;
        const md = this._buildPromptEngineeredReview();

        const tm = this.app.tabManager;
        const inputTextArea = tm?.inputTextArea as HTMLTextAreaElement | null;
        if (inputTextArea) {
            tm._resetPiRecall?.({ flush: true });
            const existing = inputTextArea.value.trim();
            inputTextArea.value = existing ? `${existing}\n\n${md}` : md;
            // Match terminal.js adjustInputHeight contract (auto +
            // bounded scrollHeight), but cap a bit higher to make room
            // for multi-line review prompts.
            inputTextArea.style.height = 'auto';
            const target = Math.min(inputTextArea.scrollHeight, 360);
            inputTextArea.style.height = `${target}px`;

            // Direct mode hides the prompt bar; flip it off so the
            // user actually sees the staged text.
            const activeTab = tm?.getActiveTab?.();
            if (activeTab && activeTab.directMode && tm.toggleDirectMode) {
                tm.toggleDirectMode();
            }

            inputTextArea.focus({ preventScroll: true });
            inputTextArea.setSelectionRange(
                inputTextArea.value.length,
                inputTextArea.value.length,
            );
        }

        const count = this.reviewComments.size;
        this._clearReviewCommentsInternal();
        this.closeRichDiffModal();
        this.app.showToast?.(
            `Review staged into terminal prompt (${count} comment${count === 1 ? '' : 's'}) — press Enter to send.`,
            { type: 'success', title: 'Diff Review' },
        );
    }

    // Internal: drop everything without the confirm dialog. Used by
    // applyReviewToTerminalPrompt after a successful stage.
    _clearReviewCommentsInternal(): void {
        this.reviewComments.clear();
        for (const el of this.diffModalBody?.querySelectorAll(
            '.diff-comment-display-row',
        ) ?? []) {
            el.remove();
        }
        for (const el of this.diffModalBody?.querySelectorAll(
            '.d2h-has-comment',
        ) ?? []) {
            el.classList.remove('d2h-has-comment');
        }
        try {
            localStorage.removeItem(this.reviewStorageKey);
        } catch {
            /* localStorage unavailable; nothing to clear */
        }
        this._updateReviewActionBar();
    }

    // localStorage helpers. Namespace by CWD so per-worktree drafts
    // don't bleed across projects. Falls back to a top-level
    // sessionsManager so the helper works in tests that wire either
    // shape (the production app exposes sessionsManager under `app`,
    // but in unit tests we often pass it directly for terseness).
    _reviewStorageKeyForCwd(): string {
        const cwd =
            this.app?.sessionsManager?.activeCWD ||
            this.sessionsManager?.activeCWD ||
            '';
        return `${this.reviewStorageKey}_${cwd}`;
    }

    _saveReviewDraft(): void {
        const key = this._reviewStorageKeyForCwd();
        try {
            if (this.reviewComments.size === 0) {
                localStorage.removeItem(key);
                return;
            }
            const payload = JSON.stringify(
                Array.from(this.reviewComments.values()),
            );
            localStorage.setItem(key, payload);
        } catch {
            /* quota / private-mode failures are non-fatal */
        }
    }

    _loadReviewDraft(): void {
        const key = this._reviewStorageKeyForCwd();
        let raw: string | null = null;
        try {
            raw = localStorage.getItem(key);
        } catch {
            return;
        }
        if (!raw) return;
        try {
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return;
            this.reviewComments.clear();
            for (const c of parsed) {
                if (
                    c &&
                    typeof c.id === 'string' &&
                    typeof c.filePath === 'string' &&
                    typeof c.codeSnippet === 'string' &&
                    typeof c.commentText === 'string'
                ) {
                    const cc = c as DiffReviewComment;
                    const key2 = this._reviewKey(cc);
                    this.reviewComments.set(key2, cc);
                }
            }
        } catch {
            /* corrupted JSON — drop it */
            try {
                localStorage.removeItem(key);
            } catch {
                /* ignore */
            }
        }
    }
}

export interface DiffStreamNodeEvent {
    event: 'start' | 'stop';
    offset: number;
    node: Node;
}

export function escapeDiffHtml(value: string): string {
    return value
        .replace(/&/gm, '&amp;')
        .replace(/</gm, '&lt;')
        .replace(/>/gm, '&gt;');
}

function tag(node: Node): string {
    return node.nodeName.toLowerCase();
}

export function nodeStream(node: Node): DiffStreamNodeEvent[] {
    const result: DiffStreamNodeEvent[] = [];
    const walk = (n: Node, offset: number): number => {
        for (let child = n.firstChild; child; child = child.nextSibling) {
            if (child.nodeType === 3 && child.nodeValue !== null) {
                offset += child.nodeValue.length;
            } else if (child.nodeType === 1) {
                result.push({ event: 'start', offset, node: child });
                offset = walk(child, offset);
                if (!tag(child).match(/br|hr|img|input/)) {
                    result.push({ event: 'stop', offset, node: child });
                }
            }
        }
        return offset;
    };
    walk(node, 0);
    return result;
}

export function mergeStreams(
    original: DiffStreamNodeEvent[],
    highlighted: DiffStreamNodeEvent[],
    value: string,
): string {
    let processed = 0;
    let result = '';
    const nodeStack: Node[] = [];

    function selectStream(): DiffStreamNodeEvent[] {
        if (!original.length || !highlighted.length) {
            return original.length ? original : highlighted;
        }
        if (original[0].offset !== highlighted[0].offset) {
            return original[0].offset < highlighted[0].offset
                ? original
                : highlighted;
        }
        return highlighted[0].event === 'start' ? original : highlighted;
    }

    function open(node: Node): void {
        const el = node as Element;
        const attrs = Array.from(el.attributes || [])
            .map((a) => `${a.name}="${escapeDiffHtml(a.value)}"`)
            .join(' ');
        result += `<${tag(node)}${attrs ? ' ' + attrs : ''}>`;
    }

    function close(node: Node): void {
        result += '</' + tag(node) + '>';
    }

    while (original.length || highlighted.length) {
        const stream = selectStream();
        result += escapeDiffHtml(value.substring(processed, stream[0].offset));
        processed = stream[0].offset;
        if (stream === original) {
            nodeStack.reverse().forEach(close);
            do {
                const item = stream.splice(0, 1)[0];
                (item.event === 'start' ? open : close)(item.node);
            } while (
                stream === original &&
                stream.length &&
                stream[0].offset === processed
            );
            nodeStack.reverse().forEach(open);
        } else {
            const item = stream.splice(0, 1)[0];
            if (item.event === 'start') {
                nodeStack.push(item.node);
            } else {
                nodeStack.pop();
            }
            (item.event === 'start' ? open : close)(item.node);
        }
    }
    return result + escapeDiffHtml(value.slice(processed));
}

export const DIFF_EXT_TO_HLJS: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    jsx: 'javascript',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    go: 'go',
    java: 'java',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    hpp: 'cpp',
    cc: 'cpp',
    cs: 'csharp',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    fish: 'shell',
    ps1: 'bash',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'ini',
    ini: 'ini',
    conf: 'ini',
    sql: 'sql',
    graphql: 'graphql',
    gql: 'graphql',
    css: 'css',
    scss: 'scss',
    less: 'less',
    html: 'xml',
    htm: 'xml',
    xml: 'xml',
    svg: 'xml',
    diff: 'diff',
    patch: 'diff',
    json: 'json',
    jsonc: 'json',
    md: 'markdown',
    markdown: 'markdown',
    lua: 'lua',
    php: 'php',
    r: 'r',
    swift: 'swift',
    kt: 'kotlin',
    kts: 'kotlin',
    makefile: 'makefile',
    mk: 'makefile',
};
