/* Φ phi — Git Diff & Git Log Controller */
import { PTYWebSocket } from './ws.js';
import { escapeHtml, getLastFolderName, worktreeGlyph } from './util.js';
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
    return t && !t.isDead && (t.coder === 'bash' || t.coder === 'pwsh') && t.title !== 'btop' && !t.isBtop;
}
// findReusableShellTab picks the shell tab a quick-command should be sent to:
//   1. the active tab, if it is itself a usable shell (user focused it);
//   2. else, only when useExistingTerminalTab is on and activeCWD is set,
//      an alive shell whose CWD matches activeCWD (exact, per normalizeCwd);
//   3. else null (caller spawns a new shell).
// Pure over a plain iterable of tab-like objects.
export function findReusableShellTab(tabs, activeTab, { useExistingTerminalTab, activeCWD } = {}) {
    if (isUsableShell(activeTab))
        return activeTab;
    const cwd = activeCWD || '';
    if (useExistingTerminalTab && cwd) {
        const wantedCWD = normalizeCwd(cwd);
        const match = Array.from(tabs).find(t => isUsableShell(t) && normalizeCwd(t.cwd || '') === wantedCWD);
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
            if (e.key === 'Escape' && this.diffModal && !this.diffModal.classList.contains('hidden')) {
                this.closeRichDiffModal();
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
        document.querySelectorAll('.diff-tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelector('.diff-tab-btn.active').classList.remove('active');
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
        // Debounced resize fitting
        let resizeTimeout;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(() => {
                if (this.isPanelOpen)
                    this.fitTerminal();
            }, 150);
        });
    }
    initTerminal() {
        const isMobile = window.innerWidth <= 768;
        this.term = new window.Terminal({
            cursorBlink: false,
            cursorStyle: 'underline',
            fontSize: isMobile ? 10 : 12,
            fontFamily: 'JetBrains Mono, monospace',
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
                white: '#e4e3e9'
            }
        });
        this.fitAddon = new window.FitAddon.FitAddon();
        this.term.loadAddon(this.fitAddon);
        this.term.open(this.diffTermContainer);
        // Graceful WebGL load
        try {
            const webgl = new window.WebglAddon.WebglAddon();
            this.term.loadAddon(webgl);
        }
        catch (e) { }
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
        // Load initial state from local storage. Desktop defaults to
        // open; mobile defaults to closed unless the user has
        // previously opened it. (Diff panel is a desktop-first tool —
        // defaulting to closed on phones avoids it eating half the
        // viewport on first launch.)
        const openState = localStorage.getItem('phi_diff_panel_open');
        const isMobileForInit = window.innerWidth <= 768;
        const shouldOpen = isMobileForInit ? openState === 'true' : openState !== 'false';
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
                    (!isMac && e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'c');
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
                    if (k === '+' || k === '=' || k === '-' || k === '_' || k === '0' || k === 'Add' || k === 'Subtract') {
                        return false;
                    }
                }
                // Allow reload / reconnect shortcuts to pass through
                if ((e.shiftKey && e.key === 'F5') || ((e.ctrlKey || e.metaKey) && (e.key === 'r' || e.key === 'R'))) {
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
            const isMobile = window.innerWidth <= 768;
            const size = isMobile ? 10 : 12;
            if (this.term.options.fontSize !== size) {
                this.term.options.fontSize = size;
            }
            this.fitAddon.fit();
            if (this.currentWs && this.term.cols && this.term.rows) {
                this.currentWs.sendResize(this.term.cols, this.term.rows);
            }
        }
        catch (e) {
            console.error("[diff] Fit error:", e);
        }
    }
    _writeStaticTerminalOutput(text, emptyText) {
        this.fitTerminal();
        this.term.reset();
        this.term.clear();
        const normalized = (text || '').replace(/\r?\n/g, '\r\n');
        this.term.write(normalized && normalized.trim() ? normalized : emptyText);
    }
    _setPanel(mode) {
        const termEl = document.getElementById('diff-term-container');
        const mdEl = document.getElementById('markdown-file-list');
        const cmdEl = document.getElementById('cmd-panel');
        const syncEl = document.getElementById('sync-panel');
        const ftEl = document.getElementById('file-tree-list');
        if (mode === 'markdown') {
            termEl.classList.add('hidden');
            mdEl.classList.remove('hidden');
            cmdEl.classList.add('hidden');
            syncEl.classList.add('hidden');
            ftEl.classList.add('hidden');
            this.actionBar.classList.add('hidden');
        }
        else if (mode === 'sync') {
            termEl.classList.add('hidden');
            mdEl.classList.add('hidden');
            cmdEl.classList.add('hidden');
            syncEl.classList.remove('hidden');
            ftEl.classList.add('hidden');
            this.actionBar.classList.add('hidden');
        }
        else if (mode === 'cmd') {
            termEl.classList.add('hidden');
            mdEl.classList.add('hidden');
            cmdEl.classList.remove('hidden');
            syncEl.classList.add('hidden');
            ftEl.classList.add('hidden');
            this.actionBar.classList.add('hidden');
        }
        else if (mode === 'files') {
            termEl.classList.add('hidden');
            mdEl.classList.add('hidden');
            cmdEl.classList.add('hidden');
            syncEl.classList.add('hidden');
            ftEl.classList.remove('hidden');
            this.actionBar.classList.add('hidden');
        }
        else {
            termEl.classList.remove('hidden');
            mdEl.classList.add('hidden');
            cmdEl.classList.add('hidden');
            syncEl.classList.add('hidden');
            ftEl.classList.add('hidden');
            if (this.activeTab === 'diff') {
                this.actionBar.classList.remove('hidden');
                this.commitSelect.classList.remove('hidden');
                this.richDiffBtn.classList.remove('hidden');
            }
            else {
                this.actionBar.classList.add('hidden');
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
                throw new Error("Failed to load commits");
            const commits = await res.json();
            const currentSelected = this.commitSelect.value || 'unstaged';
            this.commitSelect.innerHTML = `
                <option value="unstaged">Unstaged Changes</option>
                <option value="staged">Staged Changes</option>
            `;
            if (Array.isArray(commits)) {
                commits.forEach((commit) => {
                    const opt = document.createElement('option');
                    opt.value = commit.hash;
                    opt.innerText = `${commit.hash} - ${commit.subject}`;
                    this.commitSelect.appendChild(opt);
                });
            }
            if (Array.from(this.commitSelect.options).some(o => o.value === currentSelected)) {
                this.commitSelect.value = currentSelected;
            }
            else {
                this.commitSelect.value = 'unstaged';
            }
        }
        catch (e) {
            console.error("[diff] Failed to load commits list:", e);
        }
    }
    renderCmdPanel() {
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
        hiddenRow.title = 'When on, terminal commands run in a background hidden terminal without creating or switching tabs.';
        const hiddenCheckbox = document.createElement('input');
        hiddenCheckbox.type = 'checkbox';
        hiddenCheckbox.id = 'use-hidden-terminal-toggle';
        hiddenCheckbox.checked = !!this.app.useHiddenTerminal;
        // Reuse-existing-terminal-tab toggle
        const reuseRow = document.createElement('label');
        reuseRow.className = 'cmd-reuse-row';
        reuseRow.title = 'When on, terminal commands route to the first alive shell tab instead of always spawning a new one.';
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
                    body: JSON.stringify({ enabled })
                });
                this.app.useHiddenTerminal = enabled;
                this.app.showToast(enabled ? 'Will use separate hidden terminal' : 'Will use visible terminal tabs', { type: 'info', title: 'Terminal routing' });
            }
            catch (err) {
                this.app.showToast('Failed to save preference', { type: 'error', title: 'Terminal routing' });
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
                    body: JSON.stringify({ enabled })
                });
                this.app.useExistingTerminalTab = enabled;
                this.app.showToast(enabled ? 'Will reuse existing terminal tab' : 'Will always open new terminal tab', { type: 'info', title: 'Terminal routing' });
            }
            catch (err) {
                this.app.showToast('Failed to save preference', { type: 'error', title: 'Terminal routing' });
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
                const dirtyBtn = document.createElement('button');
                dirtyBtn.className = 'cmd-batch-btn cmd-dirty-btn';
                dirtyBtn.innerHTML = `⚡ Dirty`;
                dirtyBtn.title = `Run on all dirty worktrees: ${cmd.command}`;
                dirtyBtn.addEventListener('click', () => this.runCommand(cmd, 'dirty'));
                buttonsGroup.appendChild(dirtyBtn);
                const allBtn = document.createElement('button');
                allBtn.className = 'cmd-batch-btn cmd-all-btn';
                allBtn.innerHTML = `⇉ All`;
                allBtn.title = `Run on all worktrees in workspace: ${cmd.command}`;
                allBtn.addEventListener('click', () => this.runCommand(cmd, 'all'));
                buttonsGroup.appendChild(allBtn);
                left.appendChild(buttonsGroup);
                const val = document.createElement('div');
                val.className = 'cmd-val';
                val.textContent = cmd.command;
                val.title = cmd.command;
                left.appendChild(val);
                item.appendChild(left);
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
            batchHeader.innerHTML = `
                <span>⚡ "${escapeHtml(this.activeBatchResults.commandName)}" · ${escapeHtml(this.activeBatchResults.scopeLabel)}</span>
            `;
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
                titleEl.innerHTML = `<span class="worktree-glyph" style="color: var(--accent-bright); font-size: 11px;">${escapeHtml(item.glyph)}</span> <span>${escapeHtml(item.name)}</span>`;
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
                { id: 'name', label: 'Label', placeholder: 'tests', monospace: false },
                { id: 'command', label: 'Command', placeholder: 'npm test', multiline: true }
            ],
            submitLabel: 'Add Command'
        });
        if (!values)
            return;
        try {
            const res = await fetch('/api/config/terminal-commands', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: values.name, command: values.command })
            });
            if (!res.ok)
                throw new Error(await res.text() || "Failed to add command");
            await this.app.sessionsManager.loadConfig();
            this.renderCmdPanel();
            this.app.showToast(`Added terminal command "${values.name}"`, { type: 'info', title: 'Commands' });
        }
        catch (e) {
            console.error("Add command failed:", e);
            this.app.showToast(e.message, { type: 'error', title: 'Commands' });
        }
    }
    async editCommand(cmd) {
        const values = await this.app.openConfigEditor({
            title: 'Edit Terminal Command',
            subtitle: 'Rename the action or change the command sent to the shell.',
            fields: [
                { id: 'name', label: 'Label', value: cmd.name, monospace: false },
                { id: 'command', label: 'Command', value: cmd.command, multiline: true }
            ],
            submitLabel: 'Save Command'
        });
        if (!values || (values.name === cmd.name && values.command === cmd.command))
            return;
        try {
            const res = await fetch('/api/config/terminal-commands', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ old_name: cmd.name, name: values.name, command: values.command })
            });
            if (!res.ok)
                throw new Error(await res.text() || "Failed to save command");
            await this.app.sessionsManager.loadConfig();
            this.renderCmdPanel();
            this.app.showToast(`Updated terminal command "${values.name}"`, { type: 'info', title: 'Commands' });
        }
        catch (e) {
            console.error("Edit command failed:", e);
            this.app.showToast(e.message, { type: 'error', title: 'Commands' });
        }
    }
    async deleteCommand(cmd) {
        if (!confirm(`Delete terminal command "${cmd.name}"?`))
            return;
        try {
            const res = await fetch('/api/config/terminal-commands', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: cmd.name })
            });
            if (!res.ok)
                throw new Error(await res.text() || "Failed to delete command");
            await this.app.sessionsManager.loadConfig();
            this.renderCmdPanel();
        }
        catch (e) {
            console.error("Delete command failed:", e);
            alert("Delete command failed: " + e.message);
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
                const targetWts = (Array.isArray(allWts) ? allWts : []).filter(wt => dirtyMap && dirtyMap[wt.path]);
                if (targetWts.length === 0) {
                    this.app.showToast('No dirty worktrees found', { type: 'info', title: 'Batch Command' });
                    return;
                }
                await this.executeHiddenBatch(cmd, targetWts.map(wt => wt.path), `Dirty Worktrees (${targetWts.length})`);
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
                    ? allWts.map(wt => wt.path)
                    : [this.app.sessionsManager?.activeCWD || ''];
                await this.executeHiddenBatch(cmd, targetWts, `All Worktrees (${targetWts.length})`);
            }
            catch (e) {
                this.app.showToast(`Failed to scan worktrees: ${e.message}`, { type: 'error', title: 'Batch Command' });
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
            : prefix ? `${prefix} ${cmd.command}` : cmd.command;
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
            useExistingTerminalTab: this.app.useExistingTerminalTab,
            activeCWD: this.app.sessionsManager.activeCWD || '',
        });
        if (targetTab && targetTab !== activeTab) {
            this.app.tabManager.switchTab(targetTab.paneId);
        }
        if (isUsableShell(targetTab)) {
            let payload = combined;
            if (combined.length > 16 || combined.includes('\n')) {
                payload = '\x1b[200~' + combined + '\x1b[201~';
            }
            // Bug fix: previously this used activeTab.ws which meant the
            // command went to whichever tab was focused BEFORE the reuse
            // switch. Must use targetTab so the command lands in the tab
            // we just routed to.
            this.app.tabManager.sendInput(targetTab, payload + '\r');
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
                        workspace: workspace
                    })
                });
                if (!res.ok) {
                    const errText = await res.text().catch(() => 'unknown error');
                    throw new Error(errText.trim() || 'Failed to spawn shell terminal');
                }
                const data = await res.json();
                this.app.tabManager.createTab(data.pane_id, data.session_id, title, 'bash', workspace, cwd, false, false, combined);
                if (this.app.sessionsManager) {
                    this.app.sessionsManager.loadSessions();
                }
            }
            catch (e) {
                this.app.showToast(e.message, { type: 'error', title: 'Launch Shell' });
            }
        }
    }
    async executeHiddenBatch(cmd, worktreePaths, scopeLabel) {
        const prefix = this.app.tabManager.inputTextArea.value.trim();
        const combined = prefix && cmd.command.includes('{}')
            ? cmd.command.replace('{}', prefix)
            : prefix ? `${prefix} ${cmd.command}` : cmd.command;
        this.app.tabManager.inputTextArea.value = '';
        this.app.tabManager.lastInputValue = '';
        this.app.tabManager.adjustInputHeight();
        this.activeBatchResults = {
            commandName: cmd.name,
            scopeLabel: scopeLabel,
            worktrees: worktreePaths.map(wt => ({
                path: wt,
                name: getLastFolderName(wt) || wt,
                glyph: worktreeGlyph(wt),
                status: 'running',
            }))
        };
        this.renderCmdPanel();
        try {
            const res = await fetch('/api/cmd/batch-run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    command: combined,
                    worktrees: worktreePaths,
                })
            });
            if (!res.ok) {
                throw new Error(await res.text() || 'Batch command execution failed');
            }
            const data = await res.json();
            const results = data.results || [];
            if (this.activeBatchResults) {
                results.forEach(r => {
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
            const successCount = results.filter(r => r.success).length;
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
            this.app.showToast(`Batch execution failed: ${err.message}`, { type: 'error', title: 'Batch Command' });
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
        const commitVal = this.commitSelect ? this.commitSelect.value : 'unstaged';
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
                    const errText = await res.text().catch(() => 'unknown error');
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
                    const errText = await res.text().catch(() => 'unknown error');
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
            if (data && data.notGitRepo)
                return notAGitRepo('this view');
            // Connect and stream diff/log output
            this.currentWs = new PTYWebSocket(data.pane_id, (text) => {
                this.term.write(text);
            }, null, () => {
                // Closed natively on git exit
                console.log(`[diff] Stream finished for ${this.activeTab}`);
            });
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
            this.contextToggleBtn.innerText = this.currentContextLines === 3 ? "Show 30 lines of context" : "Show 3 lines of context";
        }
        await this.loadRichDiff();
    }
    toggleRichDiffLayout() {
        if (window.innerWidth <= 768)
            return;
        this.currentLayout = this.currentLayout === 'line-by-line' ? 'side-by-side' : 'line-by-line';
        if (this.layoutToggleBtn) {
            this.layoutToggleBtn.innerText = this.currentLayout === 'line-by-line' ? 'Side-by-Side' : 'Unified';
        }
        this.renderRichDiff(this.lastRawDiffText);
    }
    renderRichDiff(rawDiffText) {
        if (!rawDiffText || !rawDiffText.trim()) {
            this.diffModalBody.innerHTML = '<div style="padding: 40px; text-align: center; color: var(--text-muted); font-family: var(--font-mono);">No changes detected.</div>';
            return;
        }
        const isMobile = window.innerWidth <= 768;
        const outputFormat = isMobile ? 'line-by-line' : this.currentLayout;
        const diffHtml = window.Diff2Html.html(rawDiffText, {
            drawFileList: !isMobile,
            matching: 'lines',
            outputFormat,
            colorScheme: 'dark'
        });
        this.diffModalBody.innerHTML = diffHtml;
    }
    async loadRichDiff() {
        if (!this.diffModalBody)
            return;
        this.diffModalBody.innerHTML = '<div style="padding: 20px; color: var(--text-muted); font-family: var(--font-mono); font-size: 13px;">Loading rich diff viewer...</div>';
        const cwd = this.app.sessionsManager.activeCWD || '';
        const commitVal = this.commitSelect ? this.commitSelect.value : 'unstaged';
        try {
            const res = await fetch(`/api/git/raw-diff?cwd=${encodeURIComponent(cwd)}&commit=${encodeURIComponent(commitVal)}&context=${this.currentContextLines}`);
            if (!res.ok) {
                const errText = await res.text();
                throw new Error(errText || 'Failed to fetch raw diff');
            }
            const rawDiffText = await res.text();
            this.lastRawDiffText = rawDiffText;
            this.renderRichDiff(rawDiffText);
        }
        catch (e) {
            this.diffModalBody.innerHTML = `<div style="padding: 20px; color: var(--red); font-family: var(--font-mono); font-size: 13px;">Error: ${escapeHtml(e.message)}</div>`;
        }
    }
}
