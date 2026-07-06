/* Φ phi — Git Diff & Git Log Controller */

import { PTYWebSocket } from './ws.js';

// Normalize a CWD path for equality comparison between the active
// project context and a terminal tab's stored CWD. Handles:
//   - trailing slashes (e.g. '/projects/A' vs '/projects/A/')
//   - mixed separator styles (e.g. 'C:\\foo' vs 'C:/foo')
//
// Does NOT case-fold (path equality is OS-dependent: case-sensitive
// on Linux/macOS, case-insensitive on Windows). For phi this is fine
// because both sides are produced from the same os.Getwd / platform
// path-handling code.
function normalizeCwd(p) {
    if (!p) return '';
    return String(p).replace(/\\/g, '/').replace(/\/+$/, '');
}

export class DiffController {
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
        
        // Rich diff modal triggering
        if (this.richDiffBtn) {
            this.richDiffBtn.addEventListener('click', () => this.openRichDiffModal());
        }
        if (this.diffModalClose) {
            this.diffModalClose.addEventListener('click', () => this.closeRichDiffModal());
        }
        if (this.diffModal) {
            this.diffModal.addEventListener('click', (e) => {
                if (e.target === this.diffModal) this.closeRichDiffModal();
            });
        }
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
                if (this.isPanelOpen) this.fitTerminal();
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
        } catch (e) {}
        
        // Load initial state from local storage
        const openState = localStorage.getItem('phi_diff_panel_open');
        this.togglePanel(openState !== 'false');
    }
    
    togglePanel(isOpen) {
        this.isPanelOpen = isOpen;
        localStorage.setItem('phi_diff_panel_open', isOpen);
        
        if (isOpen) {
            this.diffPanel.classList.remove('hidden');
            this.headerDiffToggleBtn.classList.add('active');
            setTimeout(() => {
                this.fitTerminal();
                this.refreshDiff();
            }, 50);
        } else {
            this.diffPanel.classList.add('hidden');
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
        if (!this.term || !this.isPanelOpen) return;
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
        } catch (e) {
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
        if (mode === 'markdown') {
            termEl.classList.add('hidden');
            mdEl.classList.remove('hidden');
            cmdEl?.classList.add('hidden');
            this.actionBar?.classList.add('hidden');
        } else if (mode === 'cmd') {
            termEl.classList.add('hidden');
            mdEl.classList.add('hidden');
            cmdEl?.classList.remove('hidden');
            this.actionBar?.classList.add('hidden');
        } else {
            termEl.classList.remove('hidden');
            mdEl.classList.add('hidden');
            cmdEl?.classList.add('hidden');
            if (this.activeTab === 'diff') {
                this.actionBar?.classList.remove('hidden');
                this.commitSelect?.classList.remove('hidden');
                this.richDiffBtn?.classList.remove('hidden');
            } else {
                this.actionBar?.classList.add('hidden');
            }
        }
    }

    async loadCommits() {
        if (!this.commitSelect) return;
        const cwd = this.app.sessionsManager.activeCWD || '';
        try {
            const res = await fetch(`/api/git/commits?cwd=${encodeURIComponent(cwd)}`);
            if (!res.ok) throw new Error("Failed to load commits");
            const commits = await res.json();
            
            const currentSelected = this.commitSelect.value || 'unstaged';
            
            this.commitSelect.innerHTML = `
                <option value="unstaged">Unstaged Changes</option>
                <option value="staged">Staged Changes</option>
            `;
            
            if (Array.isArray(commits)) {
                commits.forEach(commit => {
                    const opt = document.createElement('option');
                    opt.value = commit.hash;
                    opt.innerText = `${commit.hash} - ${commit.subject}`;
                    this.commitSelect.appendChild(opt);
                });
            }
            
            if ([...this.commitSelect.options].some(o => o.value === currentSelected)) {
                this.commitSelect.value = currentSelected;
            } else {
                this.commitSelect.value = 'unstaged';
            }
        } catch (e) {
            console.error("[diff] Failed to load commits list:", e);
        }
    }

    renderCmdPanel() {
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
            <span>Copy Config</span>
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

        // 1b. Reuse-existing-terminal-tab toggle (sits in its own row so
        // it doesn't get squeezed off-screen on narrow widths).
        const reuseRow = document.createElement('label');
        reuseRow.className = 'cmd-reuse-row';
        reuseRow.title = 'When on, terminal commands route to the first alive shell tab instead of always spawning a new one.';
        const reuseCheckbox = document.createElement('input');
        reuseCheckbox.type = 'checkbox';
        reuseCheckbox.id = 'use-existing-terminal-tab-toggle';
        reuseCheckbox.checked = !!this.app.useExistingTerminalTab;
        reuseCheckbox.addEventListener('change', async (e) => {
            const enabled = e.target.checked;
            try {
                await fetch('/api/config/use-existing-terminal-tab', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled })
                });
                this.app.useExistingTerminalTab = enabled;
                this.app.showToast(
                    enabled ? 'Will reuse existing terminal tab' : 'Will always open new terminal tab',
                    { type: 'info', title: 'Terminal routing' }
                );
            } catch (err) {
                this.app.showToast('Failed to save preference', { type: 'error', title: 'Terminal routing' });
                e.target.checked = !enabled;
            }
        });
        const reuseText = document.createElement('span');
        reuseText.innerText = 'Reuse existing terminal tab';
        reuseRow.appendChild(reuseCheckbox);
        reuseRow.appendChild(reuseText);
        cmdEl.appendChild(reuseRow);

        // 2. Create list
        const listContainer = document.createElement('div');
        listContainer.className = 'cmd-list';

        const terminalCmds = this.app.terminalCommands || [];
        if (terminalCmds.length === 0) {
            const emptyHint = document.createElement('div');
            emptyHint.style.color = 'var(--text-muted)';
            emptyHint.style.fontSize = '12px';
            emptyHint.style.padding = '12px 4px';
            emptyHint.innerText = 'No terminal commands configured.';
            listContainer.appendChild(emptyHint);
        } else {
            terminalCmds.forEach(cmd => {
                const item = document.createElement('div');
                item.className = 'cmd-item';

                const left = document.createElement('div');
                left.className = 'cmd-item-left';

                const runBtn = document.createElement('button');
                runBtn.className = 'cmd-run-btn';
                runBtn.innerText = cmd.name;
                runBtn.title = `Click to run: ${cmd.command}`;
                runBtn.addEventListener('click', () => this.runCommand(cmd));
                left.appendChild(runBtn);

                const val = document.createElement('div');
                val.className = 'cmd-val';
                val.innerText = cmd.command;
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
                copySingleBtn.textContent = 'copy';
                copySingleBtn.addEventListener('click', () => this.copySingleCommand(cmd));
                actions.appendChild(copySingleBtn);

                // Edit
                const editBtn = document.createElement('button');
                editBtn.className = 'cmd-action-btn';
                editBtn.title = 'Edit';
                editBtn.textContent = 'edit';
                editBtn.addEventListener('click', () => this.editCommand(cmd));
                actions.appendChild(editBtn);

                // Delete
                const delBtn = document.createElement('button');
                delBtn.className = 'cmd-action-btn del';
                delBtn.title = 'Delete';
                delBtn.textContent = 'del';
                delBtn.addEventListener('click', () => this.deleteCommand(cmd));
                actions.appendChild(delBtn);

                item.appendChild(actions);
                listContainer.appendChild(item);
            });
        }

        cmdEl.appendChild(listContainer);
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
        if (!values) return;

        try {
            const res = await fetch('/api/config/terminal-commands', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: values.name, command: values.command })
            });
            if (!res.ok) throw new Error(await res.text() || "Failed to add command");
            
            await this.app.sessionsManager.loadConfig();
            this.renderCmdPanel();
            this.app.showToast(`Added terminal command "${values.name}"`, { type: 'info', title: 'Commands' });
        } catch (e) {
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
        if (!values || (values.name === cmd.name && values.command === cmd.command)) return;

        try {
            const res = await fetch('/api/config/terminal-commands', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ old_name: cmd.name, name: values.name, command: values.command })
            });
            if (!res.ok) throw new Error(await res.text() || "Failed to save command");

            await this.app.sessionsManager.loadConfig();
            this.renderCmdPanel();
            this.app.showToast(`Updated terminal command "${values.name}"`, { type: 'info', title: 'Commands' });
        } catch (e) {
            console.error("Edit command failed:", e);
            this.app.showToast(e.message, { type: 'error', title: 'Commands' });
        }
    }

    async deleteCommand(cmd) {
        if (!confirm(`Delete terminal command "${cmd.name}"?`)) return;

        try {
            const res = await fetch('/api/config/terminal-commands', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: cmd.name })
            });
            if (!res.ok) throw new Error(await res.text() || "Failed to delete command");

            await this.app.sessionsManager.loadConfig();
            this.renderCmdPanel();
        } catch (e) {
            console.error("Delete command failed:", e);
            alert("Delete command failed: " + e.message);
        }
    }

    copyAllCommands(btnElement) {
        this.app.exportCmdsConfig(btnElement);
    }

    copySingleCommand(cmd) {
        const jsonStr = JSON.stringify(cmd, null, 2);
        this.app.tabManager.copyTextRobustly(jsonStr);
    }

    async runCommand(cmd) {
        const activeTab = this.app.tabManager.getActiveTab();
        const prefix = this.app.tabManager.inputTextArea.value.trim();
        const combined = prefix && cmd.command.includes('{}')
            ? cmd.command.replace('{}', prefix)
            : prefix ? `${prefix} ${cmd.command}` : cmd.command;

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
        const isUsableShell = (t) => t && !t.isDead && (t.coder === 'bash' || t.coder === 'pwsh') && t.title !== 'btop' && !t.isBtop;

        let targetTab = isUsableShell(activeTab) ? activeTab : null;
        const activeCWD = this.app.sessionsManager.activeCWD || '';
        
        if (!targetTab && this.app.useExistingTerminalTab && activeCWD) {
            const wantedCWD = normalizeCwd(activeCWD);
            const matchingShell = Array.from(this.app.tabManager.tabs.values()).find(t =>
                isUsableShell(t) && normalizeCwd(t.cwd || '') === wantedCWD);
            if (matchingShell) {
                targetTab = matchingShell;
                this.app.tabManager.switchTab(targetTab.paneId);
            }
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
            targetTab.ws.sendInput(payload + '\r');
            this.app.tabManager.inputTextArea.value = '';
            this.app.tabManager.lastInputValue = '';
            this.app.tabManager.adjustInputHeight();
            this.app.tabManager.inputTextArea.focus({ preventScroll: true });
            this.app.tabManager._spamScrollToBottom(targetTab);
        } else {
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
            } catch (e) {
                this.app.showToast(e.message, { type: 'error', title: 'Launch Shell' });
            }
        }
    }

    async pasteCommands(btnElement) {
        await this.app.importCmdsConfig(btnElement);
        setTimeout(() => this.renderCmdPanel(), 1600);
    }

    async refreshDiff(skipLoadCommits = false) {
        if (!this.isPanelOpen || !this.term) return;

        if (this.activeTab === 'markdown') {
            this._setPanel('markdown');
            this.app.markdownManager.refreshFiles();
            return;
        }

        if (this.activeTab === 'cmd') {
            this._setPanel('cmd');
            this.renderCmdPanel();
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

        try {
            if (this.activeTab === 'diff') {
                const res = await fetch(`/api/git/raw-diff?cwd=${encodeURIComponent(cwd)}&commit=${encodeURIComponent(commitVal)}&context=3&ansi=1`);
                if (!res.ok) {
                    const errText = await res.text().catch(() => 'unknown error');
                    throw new Error(errText.trim() || 'Diff fetch error');
                }
                const text = await res.text();
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
                this._writeStaticTerminalOutput(text, '\x1b[90mClean working tree.\x1b[0m\r\n');
                return;
            }

            const res = await fetch(`/api/diff?cwd=${encodeURIComponent(cwd)}&type=${this.activeTab}&commit=${commitVal}`);
            if (!res.ok) {
                const errText = await res.text().catch(() => 'unknown error');
                throw new Error(errText.trim() || 'Spawn error');
            }
            
            const data = await res.json();
            
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
                }
            );
            
            // Send initial resize structure after socket gets active
            setTimeout(() => {
                this.fitTerminal();
            }, 100);
            
        } catch (e) {
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
        if (window.innerWidth <= 768) return;
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
        if (!this.diffModalBody) return;
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
        } catch (e) {
            this.diffModalBody.innerHTML = `<div style="padding: 20px; color: var(--red); font-family: var(--font-mono); font-size: 13px;">Error: ${e.message}</div>`;
        }
    }
}
