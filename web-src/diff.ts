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
} from './util.js';
import {
    buildVSCodeURI,
    buildVSCodeRemoteURI,
    normalizeHostname,
    isVSCodeLaunchUnsupported,
} from './vscode.js';

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
    // Diff review comment state. The map keys are the row's logical
    // identity (file + both line numbers) so switching between unified
    // and side-by-side panes preserves the user's notes; localStorage
    // gives us the same across modal open/close.
    reviewComments: Map<string, DiffReviewComment>;
    reviewActionBar: HTMLElement | null;
    reviewStorageKey: string;
    activeGitHead: string;
    activeGitBranch: string;
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
                this.refreshDiff(true); // Don't reload the list when user just changes selection
            });
        }

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
        localStorage.setItem('phi_diff_panel_open', String(isOpen));

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
            if (this.activeTab === 'diff') {
                this.actionBar?.classList.remove('hidden');
                this.commitSelect?.classList.remove('hidden');
                this.richDiffBtn?.classList.remove('hidden');
                this._refreshDiffProjectActions();
            } else {
                this.actionBar?.classList.add('hidden');
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

    async loadCommits(): Promise<void> {
        if (!this.commitSelect) return;
        const cwd = this.app.sessionsManager.activeCWD || '';
        try {
            const res = await fetch(
                `/api/git/commits?cwd=${encodeURIComponent(cwd)}`,
            );
            if (!res.ok) throw new Error('Failed to load commits');
            const commits = await res.json();

            const currentSelected = this.commitSelect.value || 'unstaged';

            const unstagedOpt = document.createElement('option');
            unstagedOpt.value = 'unstaged';
            unstagedOpt.textContent = 'Unstaged Changes';
            const stagedOpt = document.createElement('option');
            stagedOpt.value = 'staged';
            stagedOpt.textContent = 'Staged Changes';
            this.commitSelect.replaceChildren(unstagedOpt, stagedOpt);

            if (Array.isArray(commits)) {
                commits.forEach((commit: any) => {
                    const opt = document.createElement('option');
                    opt.value = commit.hash;
                    opt.innerText = `${commit.hash} - ${commit.subject}`;
                    this.commitSelect?.appendChild(opt);
                });
            }

            if (
                Array.from(this.commitSelect.options).some(
                    (o) => o.value === currentSelected,
                )
            ) {
                this.commitSelect.value = currentSelected;
            } else {
                this.commitSelect.value = 'unstaged';
            }
        } catch (e) {
            console.error('[diff] Failed to load commits list:', e);
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
            item.className = 'cmd-context-menu-item';
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

    async refreshDiff(skipLoadCommits: boolean = false): Promise<void> {
        if (!this.isPanelOpen || !this.term) return;

        if (this.activeTab === 'markdown') {
            this._setPanel('markdown');
            this.app.markdownManager.refreshFiles();
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

        this.term.clear();
        this.term.write('\x1b[35mStreaming git information...\x1b[0m\r\n\r\n');

        if (this.activeTab === 'diff' && !skipLoadCommits) {
            await this.loadCommits();
        }

        const cwd = this.app.sessionsManager.activeCWD;
        const commitVal = this.commitSelect
            ? this.commitSelect.value
            : 'unstaged';

        // Helper: render the muted "not a git repo" line into the term.
        // Used by both raw endpoints (sentinel text body) and the
        // streaming endpoint (notGitRepo:true JSON flag) so the user
        // gets a calm single muted line instead of git's raw
        // "fatal: not a git repository ..." stderr in red.
        const notAGitRepo = (label: string) => {
            this._writeStaticTerminalOutput(
                '',
                `\x1b[90mNot a git repository \u2014 ${label} is empty for this workspace.\x1b[0m\r\n`,
            );
            return;
        };

        try {
            if (this.activeTab === 'diff') {
                const res = await fetch(
                    `/api/git/raw-diff?cwd=${encodeURIComponent(cwd)}&commit=${encodeURIComponent(commitVal)}&context=3&ansi=1`,
                );
                if (!res.ok) {
                    const errText = await res
                        .text()
                        .catch(() => 'unknown error');
                    throw new Error(errText.trim() || 'Diff fetch error');
                }
                const text = await res.text();
                if (text === 'NOT_GIT_REPO') return notAGitRepo('the diff');
                this._writeStaticTerminalOutput(
                    text,
                    '\x1b[90mNo changes detected.\x1b[0m\r\n',
                );
                return;
            }

            if (this.activeTab === 'status') {
                const res = await fetch(
                    `/api/git/raw-status?cwd=${encodeURIComponent(cwd)}`,
                );
                if (!res.ok) {
                    const errText = await res
                        .text()
                        .catch(() => 'unknown error');
                    throw new Error(errText.trim() || 'Status fetch error');
                }
                const text = await res.text();
                if (text === 'NOT_GIT_REPO') return notAGitRepo('the status');
                this._writeStaticTerminalOutput(
                    text,
                    '\x1b[90mClean working tree.\x1b[0m\r\n',
                );
                return;
            }

            const res = await fetch(
                `/api/diff?cwd=${encodeURIComponent(cwd)}&type=${this.activeTab}&commit=${commitVal}`,
            );
            if (!res.ok) {
                const errText = await res.text().catch(() => 'unknown error');
                throw new Error(errText.trim() || 'Spawn error');
            }

            const data = await res.json();

            // Streaming endpoint signals non-repo via JSON flag rather
            // than by spawning a PTY that immediately exits with the
            // fatal stderr.
            if (data?.notGitRepo) return notAGitRepo('this view');

            // Connect and stream diff/log output
            this.currentWs = new PTYWebSocket(
                data.pane_id,
                (text) => {
                    this.term.write(text);
                },
                null,
                () => {
                    // Closed natively on git exit
                    console.log(`[diff] Stream finished for ${this.activeTab}`);
                },
                null,
            );

            // Send initial resize structure after socket gets active
            setTimeout(() => {
                this.fitTerminal();
            }, 100);
        } catch (e) {
            this.term.write(
                `\x1b[31mFailed to load: ${(e as Error).message}\x1b[0m\r\n`,
            );
        }
    }

    async openRichDiffModal(): Promise<void> {
        if (this.diffModal) {
            this.diffModal.classList.remove('hidden');
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
        this.diffModalBody.innerHTML =
            '<div style="padding: 20px; color: var(--text-muted); font-family: var(--font-mono); font-size: 13px;">Loading rich diff viewer...</div>';

        // Snapshot the active context BEFORE the fetch starts so a
        // server switch that lands mid-request cannot confuse the
        // per-file editor actions with stale project state. Late
        // responses that no longer match the snapshot must not
        // install links.
        const cwd = this.app.sessionsManager.activeCWD || '';
        const commitVal = this.commitSelect
            ? this.commitSelect.value
            : 'unstaged';
        const requestRoot = cwd;
        const requestHostname = normalizeHostname(this.app.hostname);
        const requestToken = (this._richDiffRequestToken || 0) + 1;
        this._richDiffRequestToken = requestToken;

        try {
            const res = await fetch(
                `/api/git/raw-diff?cwd=${encodeURIComponent(cwd)}&commit=${encodeURIComponent(commitVal)}&context=${this.currentContextLines}`,
            );
            if (requestToken !== this._richDiffRequestToken) return;
            if (!res.ok) {
                const errText = await res.text();
                throw new Error(errText || 'Failed to fetch raw diff');
            }

            // X-Phi-Git-Head / X-Phi-Git-Branch anchor the staged
            // review prompt to a concrete commit. Absent on non-git
            // repos / detached HEADs — treat empty as unknown.
            this.activeGitHead = res.headers.get('X-Phi-Git-Head') || '';
            this.activeGitBranch = res.headers.get('X-Phi-Git-Branch') || '';

            const rawDiffText = await res.text();
            if (requestToken !== this._richDiffRequestToken) return;
            // Accepted: pin the active context for per-file actions and
            // any future re-render of the same data.
            this.activeDiffRoot = requestRoot;
            this.activeDiffHostname = requestHostname;
            this.lastRawDiffText = rawDiffText;
            this.renderRichDiff(rawDiffText);
        } catch (e) {
            if (requestToken !== this._richDiffRequestToken) return;
            const errDiv = document.createElement('div');
            errDiv.style.padding = '20px';
            errDiv.style.color = 'var(--red)';
            errDiv.style.fontFamily = 'var(--font-mono)';
            errDiv.style.fontSize = '13px';
            errDiv.textContent = `Error: ${(e as Error).message}`;
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

    // Build the 3-line context snippet shown next to a review comment.
    // Walks siblings inside the same tbody to grab up to N rows above
    // and below. The diff2html .d2h-code-line already carries its
    // +/-/space prefix inside .d2h-code-line-prefix, so we read it
    // verbatim rather than prepending another character.
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
            const code = sib.querySelector(
                '.d2h-code-line, .d2h-code-side-line',
            );
            const txt = (code?.textContent || '').replace(/\s+$/, '');
            lines.push(txt);
        }
        return lines.join('\n');
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

        const snippet = existing?.codeSnippet || this._rowCodeSnippet(row);

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
            return `Please address the following code review feedback on ${label} relative to HEAD \`${head}\` in workspace \`${workspace}\`:`;
        }
        return `Please address the following code review feedback on git revision \`${commitVal}\` in workspace \`${workspace}\`:`;
    }

    _buildPromptEngineeredReview(): string {
        const comments = this._sortedReviewComments();
        const header = this._reviewContextHeader();
        const blocks: string[] = [];
        comments.forEach((c, i) => {
            const lineRef = c.newLineNumber ?? c.oldLineNumber ?? '?';
            const lang = c.filePath.split('.').pop() || '';
            const snippet = c.codeSnippet
                .split('\n')
                .map((l) => `> ${l}`)
                .join('\n');
            blocks.push(
                [
                    `#### ${i + 1}. \`${c.filePath}:${lineRef}\``,
                    `> \`\`\`${lang}`,
                    snippet,
                    `> \`\`\``,
                    `**Requested Change:**`,
                    c.commentText,
                ].join('\n'),
            );
        });
        const tail = [
            '---',
            '### Instructions for Assistant:',
            '1. Locate the exact code locations referenced above in the current workspace.',
            "2. Implement all requested changes surgically, maintaining the codebase's existing architecture, style, and comments.",
            '3. Verify your changes (build, tests, or linters) before finishing.',
        ].join('\n');
        return [
            header,
            '',
            `### Code Review Feedback (${comments.length} item${comments.length === 1 ? '' : 's'})`,
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
