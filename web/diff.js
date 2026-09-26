/* Φ phi — Git Diff & Git Log Controller */
import { PTYWebSocket } from './ws.js';
import { getLastFolderName, worktreeGlyph, isCoarseViewport, isDiffDrawerViewport, terminalPreferredFontSize, responsiveTerminalFontSize, DIFF_TERMINAL_TARGET_COLUMNS, openExternalLink, installTerminalLinkProvider, } from './util.js';
// Normalize a CWD path for equality comparison between the active
// project context and a terminal tab's stored CWD. Handles:
//   - trailing slashes (e.g. '/projects/A' vs '/projects/A/')
//   - mixed separator styles (e.g. 'C:\\foo' vs 'C:/foo')
//
// Does NOT case-fold (path equality is OS-dependent: case-sensitive
// on Linux/macOS, case-insensitive on Windows). For phi this is fine
// because both sides are produced from the same os.Getwd / platform
// path-handling code.
export function normalizeCwd(p) {
    if (!p)
        return '';
    return String(p).replace(/\\/g, '/').replace(/\/+$/, '');
}
// isUsableShell reports whether a tab is an alive bash/pwsh shell (not btop).
// Pure; returns a falsy value for null/undefined tabs (raw expression, kept
// as-is because callers only use it in boolean contexts).
export function isUsableShell(t) {
    return (t &&
        !t.isDead &&
        (t.coder === 'bash' || t.coder === 'pwsh') &&
        t.title !== 'btop' &&
        !t.isBtop);
}
// findReusableShellTab picks the shell tab a quick-command should be sent to:
//   1. the active tab, if it is itself a usable shell (user focused it);
//   2. else, only when useExistingTerminalTab is on and activeCWD is set,
//      an alive shell whose CWD matches activeCWD (exact, per normalizeCwd);
//   3. else null (caller spawns a new shell).
// Pure over a plain iterable of tab-like objects.
export function findReusableShellTab(tabs, activeTab, { useExistingTerminalTab, activeCWD, } = {}) {
    if (isUsableShell(activeTab))
        return activeTab;
    const cwd = activeCWD || '';
    if (useExistingTerminalTab && cwd) {
        const wantedCWD = normalizeCwd(cwd);
        const match = Array.from(tabs).find((t) => isUsableShell(t) && normalizeCwd(t.cwd || '') === wantedCWD);
        if (match)
            return match;
    }
    return null;
}
export class DiffController {
    app;
    activeTab; // 'diff' | 'log'
    currentWs;
    term;
    fitAddon;
    isPanelOpen;
    diffPanel;
    headerDiffToggleBtn;
    closeDiffBtn;
    refreshDiffBtn;
    copyDiffBtn;
    diffTermContainer;
    commitSelect;
    actionBar;
    richDiffBtn;
    diffModal;
    diffModalClose;
    diffModalBody;
    contextToggleBtn;
    layoutToggleBtn;
    currentContextLines;
    currentLayout;
    lastRawDiffText;
    activeBatchResults = null;
    commandContextMenuAbort;
    // Diff review comment state. The map keys are the row's logical
    // identity (file + both line numbers) so switching between unified
    // and side-by-side panes preserves the user's notes; localStorage
    // gives us the same across modal open/close.
    reviewComments;
    reviewActionBar;
    reviewStorageKey;
    activeGitHead;
    activeGitBranch;
    // Optional overrides used by unit tests + the fallback path in
    // _reviewStorageKeyForCwd. Production always reads through
    // this.app.sessionsManager; tests sometimes pass it directly for
    // terseness.
    sessionsManager;
    constructor(app) {
        this.app = app;
        this.activeTab = 'markdown'; // 'diff' | 'log'
        this.currentWs = null;
        this.term = null;
        this.fitAddon = null;
        this.isPanelOpen = true;
        this.diffPanel = document.getElementById('diff-panel');
        this.headerDiffToggleBtn = document.getElementById('header-diff-toggle-btn');
        this.closeDiffBtn = document.getElementById('close-diff-btn');
        this.refreshDiffBtn = document.getElementById('refresh-diff-btn');
        this.copyDiffBtn = document.getElementById('copy-diff-btn');
        this.diffTermContainer = document.getElementById('diff-term-container');
        this.commitSelect = document.getElementById('diff-commit-select');
        this.actionBar = document.getElementById('diff-action-bar');
        this.richDiffBtn = document.getElementById('rich-diff-btn');
        this.diffModal = document.getElementById('diff-modal');
        this.diffModalClose = document.getElementById('diff-modal-close');
        this.diffModalBody = document.getElementById('diff-modal-body');
        this.contextToggleBtn = document.getElementById('diff-context-toggle-btn');
        this.layoutToggleBtn = document.getElementById('diff-layout-toggle-btn');
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
    setupEventListeners() {
        // Toggle panel states
        this.closeDiffBtn.addEventListener('click', () => this.togglePanel(false));
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
                    }
                    else {
                        this.copyDiffBuffer();
                    }
                }
            });
        }
        // Rich diff modal triggering
        if (this.richDiffBtn) {
            this.richDiffBtn.addEventListener('click', () => this.openRichDiffModal());
        }
        if (this.diffModalClose) {
            this.diffModalClose.addEventListener('click', () => this.closeRichDiffModal());
        }
        if (this.diffModal) {
            this.diffModal.addEventListener('click', (e) => {
                if (e.target === this.diffModal)
                    this.closeRichDiffModal();
            });
        }
        // Escape closes the rich-diff modal — matches the pattern in
        // markdown.js (md-modal) and app.js (ws-modal). Document-level
        // listener so we don't need to manage focus to capture Escape.
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' &&
                this.diffModal &&
                !this.diffModal.classList.contains('hidden')) {
                this.closeRichDiffModal();
                return;
            }
            // Cmd/Ctrl+Shift+Enter: stage pending review comments into
            // the terminal prompt. Only fires when the modal is open
            // AND we actually have something to apply, so the chord
            // stays inert in unrelated modals.
            if (e.key === 'Enter' &&
                e.shiftKey &&
                (e.metaKey || e.ctrlKey) &&
                this.diffModal &&
                !this.diffModal.classList.contains('hidden') &&
                this.reviewComments.size > 0) {
                e.preventDefault();
                this.applyReviewToTerminalPrompt();
            }
        });
        if (this.contextToggleBtn) {
            this.contextToggleBtn.addEventListener('click', () => this.toggleRichDiffContext());
        }
        if (this.layoutToggleBtn) {
            this.layoutToggleBtn.addEventListener('click', () => this.toggleRichDiffLayout());
        }
        // Manual Refresh trigger
        this.refreshDiffBtn.addEventListener('click', () => this.refreshDiff());
        // Diff sub-tabs
        document.querySelectorAll('.diff-tab-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                document
                    .querySelector('.diff-tab-btn.active')
                    ?.classList.remove('active');
                btn.classList.add('active');
                this.activeTab = btn.getAttribute('data-tab');
                this.refreshDiff(false); // Reload commit list when changing tabs
                if (this.activeTab === 'markdown' && this.app.markdownManager) {
                    this.app.markdownManager.refreshFiles({ force: false });
                }
                else if (this.activeTab === 'sync' && this.app.syncManager) {
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
        let resizeTimeout;
        let lastW = window.innerWidth;
        let lastH = window.innerHeight;
        window.addEventListener('resize', () => {
            const w = window.innerWidth;
            const h = window.innerHeight;
            const heightOnly = w === lastW && h !== lastH;
            lastW = w;
            lastH = h;
            if (heightOnly && isCoarseViewport())
                return;
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(() => {
                if (this.isPanelOpen)
                    this.fitTerminal();
            }, 150);
        });
    }
    initTerminal() {
        this.term = new window.Terminal({
            cursorBlink: false,
            cursorStyle: 'underline',
            fontSize: terminalPreferredFontSize(this.app.terminalFontSize),
            fontFamily: this.app.terminalFontFamily || 'JetBrains Mono, monospace',
            theme: {
                background: '#08080a',
                foreground: '#e4e3e9',
                cursor: document.documentElement.style.getPropertyValue('--accent') || '#7c6af7',
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
                activate: (_e, text) => {
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
        }
        catch (_e) {
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
    _wireCopyHandlers(term, termContainer) {
        const copy = (text, silent) => {
            if (!text)
                return;
            this.app.tabManager.copyTextRobustly(text, silent);
        };
        term.onSelectionChange(() => {
            const sel = term.getSelection();
            if (sel)
                copy(sel, true); // silent: matches main-terminal behavior
        });
        termContainer.addEventListener('contextmenu', (e) => {
            const sel = term.getSelection();
            if (!sel)
                return;
            e.preventDefault();
            e.stopPropagation();
            copy(sel);
        }, { capture: true });
        term.attachCustomKeyEventHandler((e) => {
            if (e.type === 'keydown') {
                const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
                const isCopy = (isMac && e.metaKey && e.key.toLowerCase() === 'c') ||
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
                    if (k === '+' ||
                        k === '=' ||
                        k === '-' ||
                        k === '_' ||
                        k === '0' ||
                        k === 'Add' ||
                        k === 'Subtract') {
                        return false;
                    }
                }
                // Allow reload / reconnect shortcuts (F5, Shift+F5, Ctrl+Shift+R) to pass through
                if (e.key === 'F5' ||
                    e.code === 'F5' ||
                    ((e.ctrlKey || e.metaKey) &&
                        (e.key === 'r' || e.key === 'R'))) {
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
    copyDiffBuffer() {
        if (!this.term)
            return;
        const lines = [];
        const buffer = this.term.buffer.active;
        for (let i = 0; i < buffer.length; i++) {
            const line = buffer.getLine(i);
            if (!line)
                continue;
            lines.push(line.translateToString(true));
        }
        // Trim trailing empty/whitespace-only lines so pasted output
        // doesn't have a wall of blank padding at the end.
        while (lines.length && !lines[lines.length - 1].trim())
            lines.pop();
        const text = lines.join('\n');
        this.app.tabManager.copyTextRobustly(text);
    }
    togglePanel(isOpen) {
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
        }
        else {
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
    fitTerminal() {
        if (!this.term || !this.isPanelOpen)
            return;
        try {
            const proposed = this.fitAddon?.proposeDimensions?.();
            const size = responsiveTerminalFontSize(terminalPreferredFontSize(this.app.terminalFontSize), Number(this.term.options.fontSize), proposed?.cols, DIFF_TERMINAL_TARGET_COLUMNS);
            if (this.term.options.fontSize !== size) {
                this.term.options.fontSize = size;
            }
            this.fitAddon.fit();
            if (this.currentWs && this.term.cols && this.term.rows) {
                this.currentWs.sendResize(this.term.cols, this.term.rows);
            }
        }
        catch (e) {
            console.error('[diff] Fit error:', e);
        }
    }
    // The settings preference is intentionally a preferred reading scale;
    // fitTerminal resolves the actual size from this panel's measured grid.
    applyFontSize() {
        this.fitTerminal();
    }
    applyFontFamily(family) {
        if (!this.term)
            return;
        this.term.options.fontFamily = family || 'JetBrains Mono, monospace';
        this.fitTerminal();
    }
    _writeStaticTerminalOutput(text, emptyText) {
        this.fitTerminal();
        this.term.reset();
        this.term.clear();
        const normalized = (text || '').replace(/\r?\n/g, '\r\n');
        this.term.write(normalized?.trim() ? normalized : emptyText);
    }
    _setPanel(mode) {
        this._closeCommandContextMenu?.();
        const termEl = document.getElementById('diff-term-container');
        const mdEl = document.getElementById('markdown-file-list');
        const cmdEl = document.getElementById('cmd-panel');
        const syncEl = document.getElementById('sync-panel');
        const ftEl = document.getElementById('file-tree-list');
        if (mode === 'markdown') {
            termEl.classList.add('hidden');
            mdEl.classList.remove('hidden');
            cmdEl?.classList.add('hidden');
            syncEl?.classList.add('hidden');
            ftEl?.classList.add('hidden');
            this.actionBar?.classList.add('hidden');
        }
        else if (mode === 'sync') {
            termEl.classList.add('hidden');
            mdEl.classList.add('hidden');
            cmdEl?.classList.add('hidden');
            syncEl?.classList.remove('hidden');
            ftEl?.classList.add('hidden');
            this.actionBar?.classList.add('hidden');
        }
        else if (mode === 'cmd') {
            termEl.classList.add('hidden');
            mdEl.classList.add('hidden');
            cmdEl?.classList.remove('hidden');
            syncEl?.classList.add('hidden');
            ftEl?.classList.add('hidden');
            this.actionBar?.classList.add('hidden');
        }
        else if (mode === 'files') {
            termEl.classList.add('hidden');
            mdEl.classList.add('hidden');
            cmdEl?.classList.add('hidden');
            syncEl?.classList.add('hidden');
            ftEl?.classList.remove('hidden');
            this.actionBar?.classList.add('hidden');
        }
        else {
            termEl.classList.remove('hidden');
            mdEl.classList.add('hidden');
            cmdEl?.classList.add('hidden');
            syncEl?.classList.add('hidden');
            ftEl?.classList.add('hidden');
            if (this.activeTab === 'diff') {
                this.actionBar?.classList.remove('hidden');
                this.commitSelect?.classList.remove('hidden');
                this.richDiffBtn?.classList.remove('hidden');
            }
            else {
                this.actionBar?.classList.add('hidden');
            }
        }
    }
    async loadCommits() {
        if (!this.commitSelect)
            return;
        const cwd = this.app.sessionsManager.activeCWD || '';
        try {
            const res = await fetch(`/api/git/commits?cwd=${encodeURIComponent(cwd)}`);
            if (!res.ok)
                throw new Error('Failed to load commits');
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
                commits.forEach((commit) => {
                    const opt = document.createElement('option');
                    opt.value = commit.hash;
                    opt.innerText = `${commit.hash} - ${commit.subject}`;
                    this.commitSelect?.appendChild(opt);
                });
            }
            if (Array.from(this.commitSelect.options).some((o) => o.value === currentSelected)) {
                this.commitSelect.value = currentSelected;
            }
            else {
                this.commitSelect.value = 'unstaged';
            }
        }
        catch (e) {
            console.error('[diff] Failed to load commits list:', e);
        }
    }
    _closeCommandContextMenu() {
        this.commandContextMenuAbort?.abort();
        this.commandContextMenuAbort = null;
        const menu = document.getElementById('cmd-context-menu');
        if (menu)
            menu.remove();
    }
    _openCommandContextMenu(cmd, event) {
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
        const addItem = (label, scope) => {
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
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
        const rect = menu.getBoundingClientRect();
        const x = Number.isFinite(event.clientX) ? event.clientX : 8;
        const y = Number.isFinite(event.clientY) ? event.clientY : 8;
        const maxLeft = Math.max(8, viewportWidth - rect.width - 8);
        const maxTop = Math.max(8, viewportHeight - rect.height - 8);
        menu.style.left = `${Math.min(Math.max(8, x), maxLeft)}px`;
        menu.style.top = `${Math.min(Math.max(8, y), maxTop)}px`;
        const onDocumentClick = (e) => {
            if (!menu.contains(e.target))
                this._closeCommandContextMenu();
        };
        const onKeydown = (e) => {
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
    renderCmdPanel() {
        this._closeCommandContextMenu?.();
        const cmdEl = document.getElementById('cmd-panel');
        if (!cmdEl)
            return;
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
        copyAllBtn.addEventListener('click', () => this.copyAllCommands(copyAllBtn));
        toolbar.appendChild(copyAllBtn);
        const pasteListBtn = document.createElement('button');
        pasteListBtn.innerHTML = `
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 12px; height: 12px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
            <span>Paste Config</span>
        `;
        pasteListBtn.addEventListener('click', () => this.pasteCommands(pasteListBtn));
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
        hiddenCheckbox.checked = !!this.app.useHiddenTerminal;
        // Reuse-existing-terminal-tab toggle
        const reuseRow = document.createElement('label');
        reuseRow.className = 'cmd-reuse-row';
        reuseRow.title =
            'When on, terminal commands route to the first alive shell tab instead of always spawning a new one.';
        const reuseCheckbox = document.createElement('input');
        reuseCheckbox.type = 'checkbox';
        reuseCheckbox.id = 'use-existing-terminal-tab-toggle';
        reuseCheckbox.checked = !!this.app.useExistingTerminalTab;
        const updateReuseState = () => {
            const isHidden = hiddenCheckbox.checked;
            reuseCheckbox.disabled = isHidden;
            if (isHidden) {
                reuseRow.classList.add('disabled');
            }
            else {
                reuseRow.classList.remove('disabled');
            }
        };
        updateReuseState();
        hiddenCheckbox.addEventListener('change', async (e) => {
            const target = e.target;
            const enabled = target.checked;
            updateReuseState();
            try {
                await fetch('/api/config/use-hidden-terminal', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled }),
                });
                this.app.useHiddenTerminal = enabled;
                this.app.showToast(enabled
                    ? 'Will use separate hidden terminal'
                    : 'Will use visible terminal tabs', { type: 'info', title: 'Terminal routing' });
            }
            catch (_err) {
                this.app.showToast('Failed to save preference', {
                    type: 'error',
                    title: 'Terminal routing',
                });
                target.checked = !enabled;
                updateReuseState();
            }
        });
        reuseCheckbox.addEventListener('change', async (e) => {
            const target = e.target;
            const enabled = target.checked;
            try {
                await fetch('/api/config/use-existing-terminal-tab', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled }),
                });
                this.app.useExistingTerminalTab = enabled;
                this.app.showToast(enabled
                    ? 'Will reuse existing terminal tab'
                    : 'Will always open new terminal tab', { type: 'info', title: 'Terminal routing' });
            }
            catch (_err) {
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
        const terminalCmds = this.app.terminalCommands || [];
        if (terminalCmds.length === 0) {
            const emptyHint = document.createElement('div');
            emptyHint.style.color = 'var(--text-muted)';
            emptyHint.style.fontSize = '12px';
            emptyHint.style.padding = '12px 4px';
            emptyHint.textContent = 'No terminal commands configured.';
            listContainer.appendChild(emptyHint);
        }
        else {
            terminalCmds.forEach((cmd) => {
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
                runBtn.addEventListener('click', () => this.runCommand(cmd, 'current'));
                buttonsGroup.appendChild(runBtn);
                left.appendChild(buttonsGroup);
                const val = document.createElement('div');
                val.className = 'cmd-val';
                val.textContent = cmd.command;
                val.title = cmd.command;
                left.appendChild(val);
                item.appendChild(left);
                item.addEventListener('contextmenu', (e) => {
                    const target = e.target;
                    if (target?.closest('.cmd-item-actions'))
                        return;
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
                copySingleBtn.addEventListener('click', () => this.copySingleCommand(cmd));
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
            this.activeBatchResults.worktrees.forEach((item) => {
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
                }
                else if (item.status === 'success') {
                    badgeEl.textContent = `✓ ${item.durationMs ?? 0}ms`;
                }
                else {
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
    async addCommand() {
        const values = await this.app.openConfigEditor({
            title: 'Add Terminal Command',
            subtitle: 'Terminal commands run from the cmd panel. Use {} as a placeholder for selected input text.',
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
        if (!values)
            return;
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
        }
        catch (e) {
            console.error('Add command failed:', e);
            this.app.showToast(e.message, {
                type: 'error',
                title: 'Commands',
            });
        }
    }
    async editCommand(cmd) {
        const values = await this.app.openConfigEditor({
            title: 'Edit Terminal Command',
            subtitle: 'Rename the action or change the command sent to the shell.',
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
        if (!values ||
            (values.name === cmd.name && values.command === cmd.command))
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
        }
        catch (e) {
            console.error('Edit command failed:', e);
            this.app.showToast(e.message, {
                type: 'error',
                title: 'Commands',
            });
        }
    }
    async deleteCommand(cmd) {
        if (!confirm(`Delete terminal command "${cmd.name}"?`))
            return;
        try {
            const res = await fetch('/api/config/terminal-commands', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: cmd.name }),
            });
            if (!res.ok)
                throw new Error((await res.text()) || 'Failed to delete command');
            await this.app.sessionsManager.loadConfig();
            this.renderCmdPanel();
        }
        catch (e) {
            console.error('Delete command failed:', e);
            alert(`Delete command failed: ${e.message}`);
        }
    }
    copyAllCommands(btnElement) {
        // The cmd panel shows terminal commands (spawn new shell tabs), so the
        // copy button only exports those - not the unrelated quick_commands.
        this.app.exportTerminalCommandsConfig(btnElement);
    }
    copySingleCommand(cmd) {
        const jsonStr = JSON.stringify(cmd, null, 2);
        this.app.tabManager.copyTextRobustly(jsonStr);
    }
    async runCommand(cmd, scope = 'current') {
        if (scope === 'dirty') {
            try {
                const ws = this.app.sessionsManager?.activeWorkspace || '';
                const wtRes = await fetch(`/api/git/worktrees?cwd=${encodeURIComponent(ws)}`);
                const allWts = await wtRes.json();
                const dirtyRes = await fetch(`/api/git/worktree-dirty?cwd=${encodeURIComponent(ws)}`);
                const dirtyMap = await dirtyRes.json();
                const targetWts = (Array.isArray(allWts) ? allWts : []).filter((wt) => dirtyMap?.[wt.path]);
                if (targetWts.length === 0) {
                    this.app.showToast('No dirty worktrees found', {
                        type: 'info',
                        title: 'Batch Command',
                    });
                    return;
                }
                await this.executeHiddenBatch(cmd, targetWts.map((wt) => wt.path), `Dirty Worktrees (${targetWts.length})`);
            }
            catch (e) {
                this.app.showToast(`Failed to scan dirty worktrees: ${e.message}`, { type: 'error', title: 'Batch Command' });
            }
            return;
        }
        if (scope === 'all') {
            try {
                const ws = this.app.sessionsManager?.activeWorkspace || '';
                const wtRes = await fetch(`/api/git/worktrees?cwd=${encodeURIComponent(ws)}`);
                const allWts = await wtRes.json();
                const targetWts = Array.isArray(allWts) && allWts.length > 0
                    ? allWts.map((wt) => wt.path)
                    : [this.app.sessionsManager?.activeCWD || ''];
                await this.executeHiddenBatch(cmd, targetWts, `All Worktrees (${targetWts.length})`);
            }
            catch (e) {
                this.app.showToast(`Failed to scan worktrees: ${e.message}`, {
                    type: 'error',
                    title: 'Batch Command',
                });
            }
            return;
        }
        // scope === 'current'
        if (this.app.useHiddenTerminal) {
            const cwd = this.app.sessionsManager?.activeCWD || '';
            await this.executeHiddenBatch(cmd, [cwd], 'Hidden Terminal');
            return;
        }
        const activeTab = this.app.tabManager.getActiveTab();
        const prefix = this.app.tabManager.inputTextArea.value.trim();
        const combined = prefix && cmd.command.includes('{}')
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
        const targetTab = findReusableShellTab(this.app.tabManager.tabs.values(), activeTab, {
            useExistingTerminalTab: this.app
                .useExistingTerminalTab,
            activeCWD: this.app.sessionsManager.activeCWD || '',
        });
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
        }
        else {
            // Otherwise, launch a brand new terminal tab running the command!
            try {
                const title = `+ Shell`;
                const cwd = this.app.sessionsManager.activeCWD || '';
                const workspace = this.app.sessionsManager.activeWorkspace || '';
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
                    throw new Error(errText.trim() || 'Failed to spawn shell terminal');
                }
                const data = await res.json();
                this.app.tabManager.createTab(data.pane_id, data.session_id, title, 'bash', workspace, cwd, false, false, combined);
                if (this.app.sessionsManager) {
                    this.app.sessionsManager.loadSessions();
                }
            }
            catch (e) {
                this.app.showToast(e.message, {
                    type: 'error',
                    title: 'Launch Shell',
                });
            }
        }
    }
    async executeHiddenBatch(cmd, worktreePaths, scopeLabel) {
        const prefix = this.app.tabManager.inputTextArea.value.trim();
        const combined = prefix && cmd.command.includes('{}')
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
                throw new Error((await res.text()) || 'Batch command execution failed');
            }
            const data = await res.json();
            const results = data.results || [];
            if (this.activeBatchResults) {
                results.forEach((r) => {
                    const wtItem = this.activeBatchResults.worktrees.find((w) => w.path === r.worktree);
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
                this.app.showToast(`✓ Completed "${cmd.name}" across ${results.length} worktree(s)`, { type: 'success', title: 'Batch Command' });
            }
            else {
                this.app.showToast(`Completed "${cmd.name}": ${successCount} passed, ${failCount} failed`, { type: 'error', title: 'Batch Command' });
            }
        }
        catch (err) {
            if (this.activeBatchResults) {
                this.activeBatchResults.worktrees.forEach((w) => {
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
        }
        finally {
            if (this.app.sessionsManager?.loadWorktrees) {
                this.app.sessionsManager.loadWorktrees();
            }
            this.renderCmdPanel();
        }
    }
    async pasteCommands(btnElement) {
        await this.app.importCmdsConfig(btnElement);
        setTimeout(() => this.renderCmdPanel(), 1600);
    }
    async refreshDiff(skipLoadCommits = false) {
        if (!this.isPanelOpen || !this.term)
            return;
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
        const notAGitRepo = (label) => {
            this._writeStaticTerminalOutput('', `\x1b[90mNot a git repository \u2014 ${label} is empty for this workspace.\x1b[0m\r\n`);
            return;
        };
        try {
            if (this.activeTab === 'diff') {
                const res = await fetch(`/api/git/raw-diff?cwd=${encodeURIComponent(cwd)}&commit=${encodeURIComponent(commitVal)}&context=3&ansi=1`);
                if (!res.ok) {
                    const errText = await res
                        .text()
                        .catch(() => 'unknown error');
                    throw new Error(errText.trim() || 'Diff fetch error');
                }
                const text = await res.text();
                if (text === 'NOT_GIT_REPO')
                    return notAGitRepo('the diff');
                this._writeStaticTerminalOutput(text, '\x1b[90mNo changes detected.\x1b[0m\r\n');
                return;
            }
            if (this.activeTab === 'status') {
                const res = await fetch(`/api/git/raw-status?cwd=${encodeURIComponent(cwd)}`);
                if (!res.ok) {
                    const errText = await res
                        .text()
                        .catch(() => 'unknown error');
                    throw new Error(errText.trim() || 'Status fetch error');
                }
                const text = await res.text();
                if (text === 'NOT_GIT_REPO')
                    return notAGitRepo('the status');
                this._writeStaticTerminalOutput(text, '\x1b[90mClean working tree.\x1b[0m\r\n');
                return;
            }
            const res = await fetch(`/api/diff?cwd=${encodeURIComponent(cwd)}&type=${this.activeTab}&commit=${commitVal}`);
            if (!res.ok) {
                const errText = await res.text().catch(() => 'unknown error');
                throw new Error(errText.trim() || 'Spawn error');
            }
            const data = await res.json();
            // Streaming endpoint signals non-repo via JSON flag rather
            // than by spawning a PTY that immediately exits with the
            // fatal stderr.
            if (data?.notGitRepo)
                return notAGitRepo('this view');
            // Connect and stream diff/log output
            this.currentWs = new PTYWebSocket(data.pane_id, (text) => {
                this.term.write(text);
            }, null, () => {
                // Closed natively on git exit
                console.log(`[diff] Stream finished for ${this.activeTab}`);
            }, null);
            // Send initial resize structure after socket gets active
            setTimeout(() => {
                this.fitTerminal();
            }, 100);
        }
        catch (e) {
            this.term.write(`\x1b[31mFailed to load: ${e.message}\x1b[0m\r\n`);
        }
    }
    async openRichDiffModal() {
        if (this.diffModal) {
            this.diffModal.classList.remove('hidden');
            await this.loadRichDiff();
        }
    }
    closeRichDiffModal() {
        if (this.diffModal) {
            this.diffModal.classList.add('hidden');
        }
    }
    async toggleRichDiffContext() {
        this.currentContextLines = this.currentContextLines === 3 ? 30 : 3;
        if (this.contextToggleBtn) {
            this.contextToggleBtn.innerText =
                this.currentContextLines === 3
                    ? 'Show 30 lines of context'
                    : 'Show 3 lines of context';
        }
        await this.loadRichDiff();
    }
    toggleRichDiffLayout() {
        if (isDiffDrawerViewport())
            return;
        this.currentLayout =
            this.currentLayout === 'line-by-line'
                ? 'side-by-side'
                : 'line-by-line';
        if (this.layoutToggleBtn) {
            this.layoutToggleBtn.innerText =
                this.currentLayout === 'line-by-line'
                    ? 'Side-by-Side'
                    : 'Unified';
        }
        this.renderRichDiff(this.lastRawDiffText);
    }
    renderRichDiff(rawDiffText) {
        if (!rawDiffText?.trim()) {
            this.diffModalBody.innerHTML =
                '<div style="padding: 40px; text-align: center; color: var(--text-muted); font-family: var(--font-mono);">No changes detected.</div>';
            return;
        }
        const isDrawer = isDiffDrawerViewport();
        const outputFormat = isDrawer ? 'line-by-line' : this.currentLayout;
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
            ? String(window.DOMPurify.sanitize(diffHtml, {
                USE_PROFILES: { html: true },
                FORBID_TAGS: [
                    'script',
                    'style',
                    'iframe',
                    'object',
                    'embed',
                    'form',
                ],
            }))
            : diffHtml;
        const parsed = new DOMParser().parseFromString(safeDiffHtml, 'text/html');
        this.diffModalBody?.replaceChildren(...Array.from(parsed.body.childNodes));
        // After DOM is in place: wire up the per-row + buttons and
        // rehydrate any saved comments. Re-runs on layout toggle so
        // reviewers don't lose their notes when they flip between
        // unified and side-by-side.
        this._ensureReviewActionBar();
        this._attachDiffReviewListeners();
        this._rehydrateReviewOverlays();
        this._updateReviewActionBar();
    }
    async loadRichDiff() {
        if (!this.diffModalBody)
            return;
        this.diffModalBody.innerHTML =
            '<div style="padding: 20px; color: var(--text-muted); font-family: var(--font-mono); font-size: 13px;">Loading rich diff viewer...</div>';
        const cwd = this.app.sessionsManager.activeCWD || '';
        const commitVal = this.commitSelect
            ? this.commitSelect.value
            : 'unstaged';
        try {
            const res = await fetch(`/api/git/raw-diff?cwd=${encodeURIComponent(cwd)}&commit=${encodeURIComponent(commitVal)}&context=${this.currentContextLines}`);
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
            this.lastRawDiffText = rawDiffText;
            this.renderRichDiff(rawDiffText);
        }
        catch (e) {
            const errDiv = document.createElement('div');
            errDiv.style.padding = '20px';
            errDiv.style.color = 'var(--red)';
            errDiv.style.fontFamily = 'var(--font-mono)';
            errDiv.style.fontSize = '13px';
            errDiv.textContent = `Error: ${e.message}`;
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
    _reviewKey(info) {
        return `${info.filePath}:${info.oldLineNumber ?? ''}:${info.newLineNumber ?? ''}`;
    }
    // Walk up from a row to the nearest .d2h-file-wrapper, read its
    // .d2h-file-name text. Empty string on the unlikely chance diff2html
    // renames the class.
    _rowFilePath(row) {
        const wrapper = row.closest('.d2h-file-wrapper');
        const name = wrapper?.querySelector('.d2h-file-name');
        return name?.textContent?.trim() || '';
    }
    // Read the line number cell. Unified rows have a `.line-num1` +
    // `.line-num2` pair; side-by-side rows have just a single text
    // node. Empty cells (`.d2h-emptyplaceholder`) → null.
    _rowLineNumbers(row) {
        const ln = row.querySelector('.d2h-code-linenumber, .d2h-code-side-linenumber');
        if (!ln || ln.classList.contains('d2h-emptyplaceholder')) {
            return { oldLineNumber: null, newLineNumber: null };
        }
        const n1 = row.querySelector('.line-num1');
        const n2 = row.querySelector('.line-num2');
        const parse = (el) => {
            if (!el)
                return null;
            const txt = el.textContent?.trim() || '';
            return txt ? Number(txt) : null;
        };
        // Side-by-side rows only carry one number; fall back to
        // the cell's textContent so we still surface it.
        if (!n1 && !n2) {
            const txt = ln.textContent?.trim() || '';
            const n = txt ? Number(txt) : null;
            // Side-by-side left row is the OLD side, right is NEW.
            // Without a parent-side marker we don't know which; default
            // to "new" because that's what most reviewers comment on.
            return { oldLineNumber: null, newLineNumber: n };
        }
        return {
            oldLineNumber: parse(n1),
            newLineNumber: parse(n2),
        };
    }
    _rowLineType(row) {
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
    _extractLineInfo(row) {
        const lineType = this._rowLineType(row);
        if (!lineType)
            return null;
        const filePath = this._rowFilePath(row);
        if (!filePath)
            return null;
        const { oldLineNumber, newLineNumber } = this._rowLineNumbers(row);
        if (oldLineNumber === null && newLineNumber === null)
            return null;
        return { filePath, oldLineNumber, newLineNumber, lineType };
    }
    // Build the 3-line context snippet shown next to a review comment.
    // Walks siblings inside the same tbody to grab up to N rows above
    // and below. The diff2html .d2h-code-line already carries its
    // +/-/space prefix inside .d2h-code-line-prefix, so we read it
    // verbatim rather than prepending another character.
    _rowCodeSnippet(row, radius = 2) {
        const tbody = row.parentElement;
        if (!tbody)
            return '';
        const siblings = Array.from(tbody.children);
        const idx = siblings.indexOf(row);
        if (idx === -1)
            return '';
        const start = Math.max(0, idx - radius);
        const end = Math.min(siblings.length, idx + radius + 1);
        const lines = [];
        for (let i = start; i < end; i++) {
            const sib = siblings[i];
            const lineType = this._rowLineType(sib);
            if (!lineType)
                continue; // skip hunk headers / placeholders
            const code = sib.querySelector('.d2h-code-line, .d2h-code-side-line');
            const txt = (code?.textContent || '').replace(/\s+$/, '');
            lines.push(txt);
        }
        return lines.join('\n');
    }
    _reviewActionBarParent() {
        return this.diffModal?.querySelector('.md-modal-content') || null;
    }
    // Build the floating "X Comments | Clear | Copy | Apply" bar once.
    // Reused on every render — only its counter + visibility update.
    _ensureReviewActionBar() {
        if (this.reviewActionBar)
            return;
        const parent = this._reviewActionBarParent();
        if (!parent)
            return;
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
        applyBtn.addEventListener('click', () => this.applyReviewToTerminalPrompt());
        buttons.append(clearBtn, copyBtn, applyBtn);
        bar.appendChild(buttons);
        parent.appendChild(bar);
        this.reviewActionBar = bar;
    }
    _updateReviewActionBar() {
        if (!this.reviewActionBar)
            return;
        const count = this.reviewComments.size;
        const badge = this.reviewActionBar.querySelector('.diff-review-count-badge');
        if (badge)
            badge.textContent = String(count);
        this.reviewActionBar.classList.toggle('hidden', count === 0);
    }
    // Stamp a `+` hover button into the line-number cell of every
    // commentable row. Skips hunk headers and empty placeholders.
    _attachDiffReviewListeners() {
        if (!this.diffModalBody)
            return;
        const rows = this.diffModalBody.querySelectorAll('.d2h-diff-tbody tr');
        rows.forEach((row) => {
            // Don't double-attach after re-renders (rehydrate path).
            if (row.dataset.reviewWired === '1')
                return;
            const info = this._extractLineInfo(row);
            if (!info)
                return;
            row.dataset.reviewWired = '1';
            const lnCell = row.querySelector('.d2h-code-linenumber, .d2h-code-side-linenumber');
            if (!lnCell)
                return;
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
    _rehydrateReviewOverlays() {
        if (!this.diffModalBody)
            return;
        const rows = Array.from(this.diffModalBody.querySelectorAll('.d2h-diff-tbody tr'));
        rows.forEach((row) => {
            const info = this._extractLineInfo(row);
            if (!info)
                return;
            const key = this._reviewKey(info);
            const comment = this.reviewComments.get(key);
            if (!comment)
                return;
            row.classList.add('d2h-has-comment');
            // Skip if a display row is already attached for this key
            // (the sibling row in the other pane uses the same key).
            const next = row.nextElementSibling;
            if (next?.dataset?.reviewDisplayFor === key)
                return;
            this._renderCommentDisplayRow(row, comment);
        });
    }
    _openCommentEditor(row, info, existing) {
        // If a display row already sits below, replace it with an
        // editor instead of stacking a new one.
        const next = row.nextElementSibling;
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
            this._saveComment(info, snippet, text, existing);
        });
        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                editorRow.remove();
            }
            else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
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
            textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        }, 0);
    }
    _saveComment(info, snippet, text, existing) {
        const key = this._reviewKey(info);
        const comment = {
            id: existing?.id ||
                `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            filePath: info.filePath,
            oldLineNumber: info.oldLineNumber,
            newLineNumber: info.newLineNumber,
            lineType: info.lineType,
            codeSnippet: snippet,
            commentText: text,
            createdAt: existing?.createdAt || Date.now(),
        };
        this.reviewComments.set(key, comment);
        // Find the original row(s) and refresh display rows / highlights.
        const rows = this.diffModalBody
            ? Array.from(this.diffModalBody.querySelectorAll('.d2h-diff-tbody tr'))
            : [];
        rows.forEach((row) => {
            const rowInfo = this._extractLineInfo(row);
            if (!rowInfo || this._reviewKey(rowInfo) !== key)
                return;
            row.classList.add('d2h-has-comment');
            // Strip any in-flight editor row.
            const next = row.nextElementSibling;
            if (next?.dataset?.reviewEditingFor === key) {
                next.remove();
            }
            // Replace any prior display row for this key with the
            // freshest content (handles edits as well as inserts).
            const old = row.nextElementSibling;
            if (old?.dataset?.reviewDisplayFor === key) {
                old.remove();
            }
            this._renderCommentDisplayRow(row, comment);
        });
        this._saveReviewDraft();
        this._updateReviewActionBar();
    }
    _renderCommentDisplayRow(row, comment) {
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
    _editComment(comment) {
        const info = {
            filePath: comment.filePath,
            oldLineNumber: comment.oldLineNumber,
            newLineNumber: comment.newLineNumber,
            lineType: comment.lineType,
        };
        const rows = this.diffModalBody
            ? Array.from(this.diffModalBody.querySelectorAll('.d2h-diff-tbody tr'))
            : [];
        for (const row of rows) {
            const rowInfo = this._extractLineInfo(row);
            if (rowInfo && this._reviewKey(rowInfo) === this._reviewKey(info)) {
                this._openCommentEditor(row, info, comment);
                return;
            }
        }
    }
    _deleteComment(id) {
        let removedKey = null;
        for (const [k, v] of this.reviewComments) {
            if (v.id === id) {
                removedKey = k;
                this.reviewComments.delete(k);
                break;
            }
        }
        if (!removedKey)
            return;
        // Strip display rows + highlight class on every row with this key.
        const rows = this.diffModalBody
            ? Array.from(this.diffModalBody.querySelectorAll('.d2h-diff-tbody tr'))
            : [];
        rows.forEach((row) => {
            const info = this._extractLineInfo(row);
            if (!info)
                return;
            if (this._reviewKey(info) !== removedKey)
                return;
            row.classList.remove('d2h-has-comment');
            const next = row.nextElementSibling;
            if (next?.dataset?.reviewDisplayFor === removedKey) {
                next.remove();
            }
        });
        this._saveReviewDraft();
        this._updateReviewActionBar();
    }
    _clearReviewComments() {
        if (this.reviewComments.size === 0)
            return;
        if (!confirm(`Discard all ${this.reviewComments.size} review comment(s)?`)) {
            return;
        }
        this.reviewComments.clear();
        // Strip display rows + highlight class on every row.
        for (const el of this.diffModalBody?.querySelectorAll('.diff-comment-display-row') ?? []) {
            el.remove();
        }
        for (const el of this.diffModalBody?.querySelectorAll('.d2h-has-comment') ?? []) {
            el.classList.remove('d2h-has-comment');
        }
        this._saveReviewDraft();
        this._updateReviewActionBar();
        this.app.showToast?.('Review comments cleared', { type: 'info' });
    }
    // Stable, deterministic ordering so the staged prompt reads
    // top-to-bottom in the same order the reviewer saw them.
    _sortedReviewComments() {
        return Array.from(this.reviewComments.values()).sort((a, b) => {
            if (a.filePath !== b.filePath)
                return a.filePath < b.filePath ? -1 : 1;
            const aLine = a.newLineNumber ?? a.oldLineNumber ?? 0;
            const bLine = b.newLineNumber ?? b.oldLineNumber ?? 0;
            if (aLine !== bLine)
                return aLine - bLine;
            return a.createdAt - b.createdAt;
        });
    }
    _reviewContextHeader() {
        const commitVal = this.commitSelect?.value || 'unstaged';
        const workspace = getLastFolderName(this.app.sessionsManager?.activeCWD || '') ||
            'workspace';
        if (commitVal === 'unstaged' || commitVal === 'staged') {
            const head = this.activeGitHead || 'unknown';
            const label = commitVal === 'staged'
                ? 'staged changes'
                : 'unstaged working tree changes';
            return `Please address the following code review feedback on ${label} relative to HEAD \`${head}\` in workspace \`${workspace}\`:`;
        }
        return `Please address the following code review feedback on git revision \`${commitVal}\` in workspace \`${workspace}\`:`;
    }
    _buildPromptEngineeredReview() {
        const comments = this._sortedReviewComments();
        const header = this._reviewContextHeader();
        const blocks = [];
        comments.forEach((c, i) => {
            const lineRef = c.newLineNumber ?? c.oldLineNumber ?? '?';
            const lang = c.filePath.split('.').pop() || '';
            const snippet = c.codeSnippet
                .split('\n')
                .map((l) => `> ${l}`)
                .join('\n');
            blocks.push([
                `#### ${i + 1}. \`${c.filePath}:${lineRef}\``,
                `> \`\`\`${lang}`,
                snippet,
                `> \`\`\``,
                `**Requested Change:**`,
                c.commentText,
            ].join('\n'));
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
    _copyReviewPrompt() {
        if (this.reviewComments.size === 0)
            return;
        const md = this._buildPromptEngineeredReview();
        const tm = this.app.tabManager;
        tm?.copyTextRobustly?.(md);
    }
    applyReviewToTerminalPrompt() {
        if (this.reviewComments.size === 0)
            return;
        const md = this._buildPromptEngineeredReview();
        const tm = this.app.tabManager;
        const inputTextArea = tm?.inputTextArea;
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
            inputTextArea.setSelectionRange(inputTextArea.value.length, inputTextArea.value.length);
        }
        const count = this.reviewComments.size;
        this._clearReviewCommentsInternal();
        this.closeRichDiffModal();
        this.app.showToast?.(`Review staged into terminal prompt (${count} comment${count === 1 ? '' : 's'}) — press Enter to send.`, { type: 'success', title: 'Diff Review' });
    }
    // Internal: drop everything without the confirm dialog. Used by
    // applyReviewToTerminalPrompt after a successful stage.
    _clearReviewCommentsInternal() {
        this.reviewComments.clear();
        for (const el of this.diffModalBody?.querySelectorAll('.diff-comment-display-row') ?? []) {
            el.remove();
        }
        for (const el of this.diffModalBody?.querySelectorAll('.d2h-has-comment') ?? []) {
            el.classList.remove('d2h-has-comment');
        }
        try {
            localStorage.removeItem(this.reviewStorageKey);
        }
        catch {
            /* localStorage unavailable; nothing to clear */
        }
        this._updateReviewActionBar();
    }
    // localStorage helpers. Namespace by CWD so per-worktree drafts
    // don't bleed across projects. Falls back to a top-level
    // sessionsManager so the helper works in tests that wire either
    // shape (the production app exposes sessionsManager under `app`,
    // but in unit tests we often pass it directly for terseness).
    _reviewStorageKeyForCwd() {
        const cwd = this.app?.sessionsManager?.activeCWD ||
            this.sessionsManager?.activeCWD ||
            '';
        return `${this.reviewStorageKey}_${cwd}`;
    }
    _saveReviewDraft() {
        const key = this._reviewStorageKeyForCwd();
        try {
            if (this.reviewComments.size === 0) {
                localStorage.removeItem(key);
                return;
            }
            const payload = JSON.stringify(Array.from(this.reviewComments.values()));
            localStorage.setItem(key, payload);
        }
        catch {
            /* quota / private-mode failures are non-fatal */
        }
    }
    _loadReviewDraft() {
        const key = this._reviewStorageKeyForCwd();
        let raw = null;
        try {
            raw = localStorage.getItem(key);
        }
        catch {
            return;
        }
        if (!raw)
            return;
        try {
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed))
                return;
            this.reviewComments.clear();
            for (const c of parsed) {
                if (c &&
                    typeof c.id === 'string' &&
                    typeof c.filePath === 'string' &&
                    typeof c.codeSnippet === 'string' &&
                    typeof c.commentText === 'string') {
                    const cc = c;
                    const key2 = this._reviewKey(cc);
                    this.reviewComments.set(key2, cc);
                }
            }
        }
        catch {
            /* corrupted JSON — drop it */
            try {
                localStorage.removeItem(key);
            }
            catch {
                /* ignore */
            }
        }
    }
}
