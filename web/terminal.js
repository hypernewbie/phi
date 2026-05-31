/* Φ phi — Terminal & Tab Manager */

import { PTYWebSocket } from './ws.js';

export class TabManager {
    constructor(app) {
        this.app = app;
        this.tabs = new Map(); // paneId -> TabInfo
        this.activePaneId = null;
        
        this.tabsContainer = document.getElementById('tabs-container');
        this.terminalsWrapper = document.getElementById('terminals-wrapper');
        this.inputBarContainer = document.getElementById('input-bar-container');
        this.inputTextArea = document.getElementById('input-textarea');
        this.sendInputBtn = document.getElementById('send-input-btn');
        this.cancelInputBtn = document.getElementById('cancel-input-btn');
        this.copyInputBtn = document.getElementById('copy-input-btn');
        this.directModeToggle = document.getElementById('direct-mode-toggle');
        this.presetsContainer = document.getElementById('presets-container');
        
        // History preset queue
        this.recentCommands = JSON.parse(localStorage.getItem('phi_recent_commands')) || [];
        
        this.setupEventListeners();
    }
    
    saveTabsState() {
        const tabsData = [];
        for (const tab of this.tabs.values()) {
            tabsData.push({ paneId: tab.paneId, sessionId: tab.sessionId, title: tab.title, coder: tab.coder });
        }
        localStorage.setItem('phi_tabs', JSON.stringify(tabsData));
        localStorage.setItem('phi_active_pane', this.activePaneId || '');
    }

    restoreTabsState() {
        let tabsData;
        try {
            tabsData = JSON.parse(localStorage.getItem('phi_tabs') || '[]');
        } catch (e) {
            return;
        }
        if (!tabsData.length) return;

        const savedActive = localStorage.getItem('phi_active_pane') || '';
        for (const t of tabsData) {
            this.createTab(t.paneId, t.sessionId, t.title, t.coder);
        }
        if (savedActive && this.tabs.has(savedActive)) {
            this.switchTab(savedActive);
        }
    }

    setupEventListeners() {
        // Click/focus input bar → exit direct mode
        this.inputTextArea.addEventListener('focus', () => {
            const activeTab = this.getActiveTab();
            if (activeTab && activeTab.directMode) {
                activeTab.directMode = false;
                this.updateDirectModeUI(activeTab);
            }
        });

        // Staged input send on Enter
        this.inputTextArea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendStagedInput();
            } else if (e.key === 'Escape') {
                // Return focus to terminal in Hybrid mode
                e.preventDefault();
                this.inputTextArea.blur();
                this.focusActiveTerminal();
            }
        });
        
        this.sendInputBtn.addEventListener('click', () => {
            this.sendStagedInput();
        });

        if (this.cancelInputBtn) {
            this.cancelInputBtn.addEventListener('click', () => {
                this.sendRawInput('\x03');
                this.inputTextArea.focus();
            });
        }

        if (this.copyInputBtn) {
            this.copyInputBtn.addEventListener('click', () => {
                this.sendRawInput('/copy\r');
                this.inputTextArea.focus();
            });
        }

        const closeAllBtn = document.getElementById('close-all-tabs-btn');
        if (closeAllBtn) {
            closeAllBtn.addEventListener('click', () => {
                if (this.tabs.size === 0) return;
                if (confirm(`Are you sure you want to close all ${this.tabs.size} active sessions?`)) {
                    const keys = Array.from(this.tabs.keys());
                    keys.forEach(paneId => {
                        this.closeTab(paneId);
                    });
                    this.app.sessionsManager.loadSessions();
                }
            });
        }
        
        // Direct Mode toggle
        this.directModeToggle.addEventListener('click', () => {
            const activeTab = this.getActiveTab();
            if (!activeTab) return;
            
            activeTab.directMode = !activeTab.directMode;
            this.updateDirectModeUI(activeTab);
            
            if (activeTab.directMode) {
                this.focusActiveTerminal();
            } else {
                this.inputTextArea.focus();
            }
        });
        
        // Fit active terminal on window resize
        let resizeTimeout;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(() => {
                this.fitActiveTerminal();
            }, 100);
        });
    }
    
    getActiveTab() {
        return this.tabs.get(this.activePaneId);
    }
    
    focusActiveTerminal() {
        const activeTab = this.getActiveTab();
        if (activeTab && activeTab.term) {
            activeTab.term.focus();
        }
    }
    
    updateDirectModeUI(tab) {
        if (tab.directMode) {
            this.directModeToggle.classList.add('active');
            this.inputBarContainer.classList.add('direct-mode-active');
            this.inputBarContainer.classList.remove('hidden');
            this.presetsContainer.classList.add('hidden');
        } else {
            this.directModeToggle.classList.remove('active');
            this.inputBarContainer.classList.remove('direct-mode-active');
            this.inputBarContainer.classList.remove('hidden');
            this.presetsContainer.classList.remove('hidden');
            // Make sure presets exist and are populated
            this.renderPresets(tab.coder);
        }
        this.fitActiveTerminal();
    }
    
    createTab(paneId, sessionId, title, coder) {
        // If tab already exists, just switch to it
        if (this.tabs.has(paneId)) {
            this.switchTab(paneId);
            return;
        }
        
        // Create elements
        const tabEl = document.createElement('div');
        tabEl.className = 'tab';
        tabEl.setAttribute('data-pane-id', paneId);
        tabEl.innerHTML = `
            <span class="tab-title">${title}</span>
            <button class="tab-close">×</button>
        `;
        
        const termContainer = document.createElement('div');
        termContainer.className = 'term-container';
        termContainer.id = `term-${paneId}`;
        
        this.tabsContainer.appendChild(tabEl);
        this.terminalsWrapper.appendChild(termContainer);
        
        tabEl.addEventListener('click', (e) => {
            if (e.target.closest('.tab-close')) {
                e.stopPropagation();
                this.closeTab(paneId);
            } else {
                this.switchTab(paneId);
            }
        });
        
        // Initialize xterm.js instance
        const term = new window.Terminal({
            cursorBlink: true,
            cursorStyle: 'bar',
            fontSize: 14,
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
        
        const fitAddon = new window.FitAddon.FitAddon();
        term.loadAddon(fitAddon);
        
        // Open in DOM
        term.open(termContainer);
        
        // Graceful WebGL/Canvas renderer
        try {
            const webgl = new window.WebglAddon.WebglAddon();
            term.loadAddon(webgl);
            console.log("[term] Loaded WebGL hardware acceleration");
        } catch (e) {
            console.warn("[term] Falling back to standard canvas renderer");
        }
        
        // Setup WebSocket connection
        let ws;
        const tabInfo = {
            paneId,
            sessionId,
            title,
            coder,
            term,
            fitAddon,
            tabEl,
            termContainer,
            directMode: false, // Hybrid focus model by default
            isDead: false
        };
        
        ws = new PTYWebSocket(
            paneId,
            (data) => {
                term.write(data);
            },
            (control) => {
                console.log("[ws] Received control:", control);
            },
            () => {
                term.write('\r\n\x1b[31m[Phi Connection Terminated]\x1b[0m\r\n');
                tabInfo.isDead = true;
                tabEl.classList.add('dead');
            }
        );
        
        tabInfo.ws = ws;
        this.tabs.set(paneId, tabInfo);
        
        // Direct writing bridge
        term.onData((data) => {
            if (tabInfo.directMode && !tabInfo.isDead) {
                ws.sendInput(data);
            }
        });
        
        // Click terminal → enter direct input mode
        termContainer.addEventListener('click', () => {
            const tab = this.tabs.get(paneId);
            if (tab && !tab.directMode) {
                tab.directMode = true;
                this.updateDirectModeUI(tab);
            }
            term.focus();
        });
        
        // Switch to the newly created tab
        this.switchTab(paneId);
        this.saveTabsState();
        
        // Initial fit delay to let rendering engine draw
        setTimeout(() => {
            this.fitActiveTerminal();
            this.sendResizeToBackend(tabInfo);
        }, 100);
    }
    
    switchTab(paneId) {
        if (this.activePaneId === paneId) return;
        
        // Deactivate current active tab
        const prevTab = this.getActiveTab();
        if (prevTab) {
            prevTab.tabEl.classList.remove('active');
            prevTab.termContainer.classList.remove('active');
        }
        
        // Set new active tab
        this.activePaneId = paneId;
        const newTab = this.getActiveTab();
        if (!newTab) return;
        
        newTab.tabEl.classList.add('active');
        newTab.termContainer.classList.add('active');
        
        // Show/hide staged input & direct mode based on tab settings
        this.inputBarContainer.classList.remove('hidden');
        this.updateDirectModeUI(newTab);
        
        // Scroll tabs bar to active tab
        newTab.tabEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
        this.saveTabsState();
        
        // Update sidebar select state
        this.app.sessionsManager.highlightActiveSession(newTab.sessionId);
        
        // Trigger resize calculation
        setTimeout(() => {
            this.fitActiveTerminal();
        }, 50);
    }
    
    closeTab(paneId) {
        const tab = this.tabs.get(paneId);
        if (!tab) return;

        // Kill the server-side PTY process (fire-and-forget)
        fetch(`/api/terminals/${paneId}`, { method: 'DELETE' }).catch(() => {});

        try {
            if (tab.ws) tab.ws.close();
        } catch (e) {
            console.error("[tab] WS close error:", e);
        }

        try {
            if (tab.term) tab.term.dispose();
        } catch (e) {
            console.error("[tab] Term dispose error:", e);
        }
        
        try {
            if (tab.tabEl) tab.tabEl.remove();
            if (tab.termContainer) tab.termContainer.remove();
        } catch (e) {
            console.error("[tab] DOM removal error:", e);
        }
        
        this.tabs.delete(paneId);
        
        this.saveTabsState();

        // If we closed the active tab, switch to another
        if (this.activePaneId === paneId) {
            const remainingKeys = Array.from(this.tabs.keys());
            if (remainingKeys.length > 0) {
                this.switchTab(remainingKeys[remainingKeys.length - 1]);
            } else {
                this.activePaneId = null;
                this.inputBarContainer.classList.add('hidden');
                this.presetsContainer.classList.add('hidden');
            }
        }
    }
    
    sendStagedInput() {
        const activeTab = this.getActiveTab();
        if (!activeTab || activeTab.isDead) return;
        
        const val = this.inputTextArea.value;
        if (!val) return;
        
        // Wrap in bracketed paste markers for large prompts or multiline text
        // to prevent TUI trickle-rendering / autocomplete lagging.
        let payload = val;
        if (val.length > 16 || val.includes('\n')) {
            payload = '\x1b[200~' + val + '\x1b[201~';
        }
        
        activeTab.ws.sendInput(payload + '\r');
        this.inputTextArea.value = '';

        // Auto sync clipboard on /copy command
        if (val.includes('/copy')) {
            setTimeout(() => {
                this.app.syncRemoteClipboard();
            }, 300);
        }
        
        // Save to unique recent commands list
        const trimmed = val.trim();
        if (trimmed) {
            this.recentCommands = this.recentCommands.filter(cmd => cmd !== trimmed);
            this.recentCommands.push(trimmed);
            if (this.recentCommands.length > 10) {
                this.recentCommands.shift();
            }
            localStorage.setItem('phi_recent_commands', JSON.stringify(this.recentCommands));
            this.renderPresets(activeTab.coder);
        }
        
        this.inputTextArea.focus();
    }
    
    sendRawInput(bytes) {
        const activeTab = this.getActiveTab();
        if (!activeTab || activeTab.isDead) return;
        // The backend PTY layer handles the Windows ConPTY quirk where a \r
        // bundled with preceding text fails to register as Enter — see pkg/pty.
        activeTab.ws.sendInput(bytes);
        this.focusActiveTerminal();

        // Auto sync clipboard on /copy command
        if (bytes.includes('/copy')) {
            setTimeout(() => {
                this.app.syncRemoteClipboard();
            }, 300);
        }
    }
    
    fitActiveTerminal() {
        const activeTab = this.getActiveTab();
        if (!activeTab || activeTab.isDead) return;
        
        try {
            activeTab.fitAddon.fit();
            this.sendResizeToBackend(activeTab);
        } catch (e) {
            console.error("[term] Fit error:", e);
        }
    }
    
    sendResizeToBackend(tab) {
        if (!tab || tab.isDead) return;
        const term = tab.term;
        if (term.cols && term.rows) {
            tab.ws.sendResize(term.cols, term.rows);
        }
    }
    
    renderPresets(coderId) {
        this.presetsContainer.innerHTML = '';
        
        const coderPresetInfo = this.app.codersPresetRegistry[coderId];
        const hasCoderPresets = coderPresetInfo && coderPresetInfo.presets && coderPresetInfo.presets.length > 0;
        
        // If direct mode, do not render presets
        const activeTab = this.getActiveTab();
        if (activeTab && activeTab.directMode) {
            this.presetsContainer.classList.add('hidden');
            return;
        }
        
        // Hide presets container if absolutely nothing to show
        if (!hasCoderPresets && this.recentCommands.length === 0) {
            this.presetsContainer.classList.add('hidden');
            return;
        }
        
        this.presetsContainer.classList.remove('hidden');
        
        // 1. Render Static Coder Presets
        if (hasCoderPresets) {
            coderPresetInfo.presets.forEach(p => {
                const btn = document.createElement('button');
                btn.className = 'preset-btn';
                btn.innerText = p.name;
                btn.addEventListener('click', () => {
                    this.sendRawInput(p.value);
                });
                this.presetsContainer.appendChild(btn);
            });
        }
        
        // 2. Render Vertical Divider if both types exist
        if (hasCoderPresets && this.recentCommands.length > 0) {
            const divider = document.createElement('div');
            divider.className = 'presets-divider';
            this.presetsContainer.appendChild(divider);
        }
        
        // 3. Render Rotating Unique Recent Commands
        const reversedRecents = [...this.recentCommands].reverse();
        reversedRecents.forEach(cmd => {
            const btn = document.createElement('button');
            btn.className = 'preset-btn recent-cmd-btn';
            
            const label = cmd.length > 16 ? cmd.substring(0, 15) + '…' : cmd;
            btn.innerText = `⏱ ${label}`;
            btn.title = cmd;
            
            btn.addEventListener('click', () => {
                this.sendRawInput(cmd + '\r');
            });
            this.presetsContainer.appendChild(btn);
        });
    }

    applyThemeToAllActiveTerminals(color) {
        for (const tab of this.tabs.values()) {
            if (tab.term) {
                tab.term.options.theme = {
                    ...tab.term.options.theme,
                    cursor: color
                };
            }
        }
    }
}
