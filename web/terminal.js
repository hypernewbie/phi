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
        this.directModeToggle = document.getElementById('direct-mode-toggle');
        this.presetsContainer = document.getElementById('presets-container');
        
        this.setupEventListeners();
    }
    
    setupEventListeners() {
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
            this.inputBarContainer.classList.add('hidden');
            this.presetsContainer.classList.add('hidden');
        } else {
            this.directModeToggle.classList.remove('active');
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
        
        // Tab click and Close click listeners
        tabEl.addEventListener('click', (e) => {
            if (e.target.classList.contains('tab-close')) {
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
                cursor: '#7c6af7',
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
        
        // Force focus terminal when clicked
        termContainer.addEventListener('click', () => {
            term.focus();
        });
        
        // Switch to the newly created tab
        this.switchTab(paneId);
        
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
        
        // Close WS and clean up
        tab.ws.close();
        tab.term.dispose();
        
        tab.tabEl.remove();
        tab.termContainer.remove();
        
        this.tabs.delete(paneId);
        
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
        
        activeTab.ws.sendInput(val + '\n');
        this.inputTextArea.value = '';
        this.focusActiveTerminal();
    }
    
    sendRawInput(bytes) {
        const activeTab = this.getActiveTab();
        if (!activeTab || activeTab.isDead) return;
        activeTab.ws.sendInput(bytes);
        this.focusActiveTerminal();
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
        if (!coderPresetInfo || !coderPresetInfo.presets) {
            this.presetsContainer.classList.add('hidden');
            return;
        }
        
        this.presetsContainer.classList.remove('hidden');
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
}
