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
        
        this.setupEventListeners();
    }
    
    setupEventListeners() {
        // Toggle panel states
        this.closeDiffBtn.addEventListener('click', () => this.togglePanel(false));
        this.headerDiffToggleBtn.addEventListener('click', () => {
            this.togglePanel(!this.isPanelOpen);
        });
        
        // Manual Refresh trigger
        this.refreshDiffBtn.addEventListener('click', () => this.refreshDiff());
        
        // Diff sub-tabs
        document.querySelectorAll('.diff-tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelector('.diff-tab-btn.active').classList.remove('active');
                btn.classList.add('active');
                this.activeTab = btn.getAttribute('data-tab');
                this.refreshDiff();
            });
        });
        
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
        } else {
            termEl.classList.remove('hidden');
            mdEl.classList.add('hidden');
        }
    }

    async refreshDiff() {
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

        const cwd = this.app.sessionsManager.activeCWD;
        try {
            const res = await fetch(`/api/diff?cwd=${encodeURIComponent(cwd)}&type=${this.activeTab}`);
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
}
