/* Φ phi — Git Diff & Git Log Controller */

import { PTYWebSocket } from './ws.js';

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
        this.term = new window.Terminal({
            cursorBlink: false,
            cursorStyle: 'underline',
            fontSize: 12,
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
            this.fitAddon.fit();
            if (this.currentWs && this.term.cols && this.term.rows) {
                this.currentWs.sendResize(this.term.cols, this.term.rows);
            }
        } catch (e) {
            console.error("[diff] Fit error:", e);
        }
    }
    
    _setPanel(mode) {
        const termEl = document.getElementById('diff-term-container');
        const mdEl = document.getElementById('markdown-file-list');
        if (mode === 'markdown') {
            termEl.classList.add('hidden');
            mdEl.classList.remove('hidden');
            this.actionBar?.classList.add('hidden');
            this.commitSelect?.classList.add('hidden');
            this.richDiffBtn?.classList.add('hidden');
        } else {
            termEl.classList.remove('hidden');
            mdEl.classList.add('hidden');
            this.actionBar?.classList.remove('hidden');
            if (this.activeTab === 'diff') {
                this.commitSelect?.classList.remove('hidden');
                this.richDiffBtn?.classList.remove('hidden');
            } else {
                this.commitSelect?.classList.add('hidden');
                this.richDiffBtn?.classList.add('hidden');
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
            
            this.commitSelect.innerHTML = '<option value="unstaged">Unstaged Changes</option>';
            
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

    async refreshDiff(skipLoadCommits = false) {
        if (!this.isPanelOpen || !this.term) return;

        if (this.activeTab === 'markdown') {
            this._setPanel('markdown');
            this.app.markdownManager.refreshFiles();
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

        const diffHtml = window.Diff2Html.html(rawDiffText, {
            drawFileList: true,
            matching: 'lines',
            outputFormat: this.currentLayout,
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
