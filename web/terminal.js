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
        
        this.setupEventListeners();

        // Prompt for OS-level notification permissions on page load if not configured.
        if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
            Notification.requestPermission();
        }

        // Listen for visibility state changes to clear indicators dynamically.
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) {
                this.clearAttentionIndicators();
            }
        });

        // Initialise the 1-second background visual idle and prompt detection loop.
        setInterval(() => {
            this.pollTerminalIdleAndNotifications();
        }, 1000);
    }
    
    saveTabsState() {
        const tabsData = [];
        for (const tab of this.tabs.values()) {
            tabsData.push({
                paneId: tab.paneId,
                sessionId: tab.sessionId,
                title: tab.title,
                coder: tab.coder,
                workspace: tab.workspace,
                cwd: tab.cwd,
                pinned: !!tab.pinned
            });
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
            this.createTab(t.paneId, t.sessionId, t.title, t.coder, t.workspace, t.cwd, t.pinned);
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
            // When input is empty, capture arrows, enter, escape and ctrl key shortcuts to control PTY directly.
            if (this.inputTextArea.value === '') {
                const keys = {
                    'ArrowUp': '\u001b[A',
                    'ArrowDown': '\u001b[B',
                    'ArrowLeft': '\u001b[D',
                    'ArrowRight': '\u001b[C',
                    'Enter': '\r',
                    'Escape': '\x1b'
                };
                
                let sendChar = null;
                if (keys[e.key]) {
                    sendChar = keys[e.key];
                } else if (e.ctrlKey) {
                    const ctrlKeys = {
                        'c': '\x03',
                        'o': '\x0f',
                        'p': '\x10'
                    };
                    const lowerKey = e.key.toLowerCase();
                    if (ctrlKeys[lowerKey]) {
                        sendChar = ctrlKeys[lowerKey];
                    }
                }

                if (sendChar !== null) {
                    e.preventDefault();
                    const activeTab = this.getActiveTab();
                    if (activeTab && !activeTab.isDead) {
                        activeTab.ws.sendInput(sendChar);
                        this._spamScrollToBottom(activeTab); // Keep viewport pinned to the bottom during reaction
                    }
                    return;
                }
            }

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
                const activeTab = this.getActiveTab();
                const cancelKey = (activeTab && ['pi', 'claude', 'opencode'].includes(activeTab.coder)) ? '\x1b' : '\x03';
                this.sendRawInput(cancelKey);
                this.inputTextArea.focus({ preventScroll: true });
            });
        }

        if (this.copyInputBtn) {
            this.copyInputBtn.addEventListener('click', () => {
                this.sendRawInput('/copy\r');
                this.inputTextArea.focus({ preventScroll: true });
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
                this.inputTextArea.focus({ preventScroll: true });
            }
        });
        
        // Fit active terminal on window resize
        let resizeTimeout;
        window.addEventListener('resize', () => {
            const activeTab = this.getActiveTab();
            if (activeTab && !activeTab.isDead) {
                activeTab.isAtBottom = true;
            }
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(() => {
                this.fitActiveTerminal();
            }, 100);
        });

        // Close model presets dropup on clicking outside
        document.addEventListener('click', (e) => {
            const dropup = document.getElementById('model-presets-dropup');
            if (dropup && !dropup.classList.contains('hidden')) {
                if (!e.target.closest('#model-presets-dropup') && !e.target.closest('.model-trigger-btn')) {
                    dropup.classList.add('hidden');
                }
            }
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
    
    writeToTerminal(tabInfo, data) {
        if (tabInfo.isDead) return;

        tabInfo.writeBuffer += data;

        // Track PTY activity on output.
        tabInfo.lastOutputAt = Date.now();
        if (!tabInfo.isBusy) {
            tabInfo.isBusy = true;
            // If not manually pinned by the user, dynamically pin on the backend while busy.
            if (!tabInfo.pinned) {
                this.syncBackendPin(tabInfo.paneId, true);
            }
        }

        if (!tabInfo.writePending) {
            tabInfo.writePending = true;
            requestAnimationFrame(() => {
                if (tabInfo.writeBuffer.length > 0 && !tabInfo.isDead) {
                    tabInfo.term.write(tabInfo.writeBuffer);
                    tabInfo.writeBuffer = '';
                }
                tabInfo.writePending = false;
            });
        }
    }
    
    updateDirectModeUI(tab) {
        // Save scroll state before DOM changes alter the terminal height
        if (tab && !tab.isDead && tab.isAtBottom === undefined) {
            const buffer = tab.term.buffer.active;
            tab.isAtBottom = buffer.viewportY >= buffer.baseY - 1;
            tab.lastScrollY = buffer.viewportY;
        }

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
    
    createTab(paneId, sessionId, title, coder, workspace = '', cwd = '', pinned = false) {
        // If tab already exists, just switch to it
        if (this.tabs.has(paneId)) {
            this.switchTab(paneId);
            return;
        }
        
        // Create elements
        const tabEl = document.createElement('div');
        tabEl.className = 'tab';
        if (pinned) tabEl.classList.add('pinned');
        tabEl.setAttribute('data-pane-id', paneId);
        tabEl.innerHTML = `
            <button class="tab-pin" title="Pin session (Keep alive overnight)">📌</button>
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
            } else if (e.target.closest('.tab-pin')) {
                e.stopPropagation();
                this.togglePinTab(paneId);
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
        
        // Prevent browser viewport jump when xterm focuses its hidden textarea
        const textarea = termContainer.querySelector('textarea.xterm-helper-textarea');
        if (textarea) {
            const originalFocus = textarea.focus.bind(textarea);
            textarea.focus = (options) => {
                originalFocus({ preventScroll: true, ...options });
            };
        }

        // Right-click on terminal → copy xterm selection.
        // Uses capture phase on termContainer so we fire BEFORE xterm's own
        // contextmenu handler (which calls stopPropagation and blocks bubble-phase listeners).
        termContainer.addEventListener('contextmenu', async (e) => {
            const sel = term.getSelection();
            if (!sel) return;
            e.preventDefault();
            e.stopPropagation();
            try {
                await navigator.clipboard.writeText(sel);
            } catch {
                const ta = Object.assign(document.createElement('textarea'), { value: sel });
                ta.style.cssText = 'position:fixed;opacity:0';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                ta.remove();
            }
        }, { capture: true });

        term.attachCustomKeyEventHandler((e) => {
            // In non-direct mode: redirect printable keystrokes to the input textarea
            if (!tabInfo.directMode && e.type === 'keydown' && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
                this.inputTextArea.value += e.key;
                this.inputTextArea.focus({ preventScroll: true });
                const len = this.inputTextArea.value.length;
                this.inputTextArea.setSelectionRange(len, len);
                return false;
            }
            // Prevent browser default for standard CLI shortcuts in direct mode
            if (tabInfo.directMode && e.ctrlKey && !e.altKey && !e.shiftKey) {
                const key = e.key.toLowerCase();
                if (['o', 's', 'p', 'f', 'r', 'g'].includes(key)) e.preventDefault();
            }
            return true;
        });
        
        // Setup terminal bell notification sound.
        const bellAudio = new Audio('vendor/bell.wav');
        bellAudio.volume = 0.3;
        term.onBell(() => {
            bellAudio.currentTime = 0;
            bellAudio.play().catch(() => {});
        });
        
        // Graceful WebGL/Canvas renderer
        try {
            const webgl = new window.WebglAddon.WebglAddon();
            term.loadAddon(webgl);
            console.log("[term] Loaded WebGL hardware acceleration");
        } catch (e) {
            console.warn("[term] Falling back to standard canvas renderer");
        }
        
        const activeWS = workspace || (this.app.sessionsManager ? this.app.sessionsManager.activeWorkspace : '');
        const activeCWD = cwd || (this.app.sessionsManager ? this.app.sessionsManager.activeCWD : '');

        // Setup WebSocket connection
        let ws;
        const tabInfo = {
            paneId,
            sessionId,
            title,
            coder,
            workspace: activeWS,
            cwd: activeCWD,
            term,
            fitAddon,
            tabEl,
            termContainer,
            directMode: false, // Hybrid focus model by default
            isDead: false,
            isAtBottom: true,
            pinned: !!pinned,
            lastOutputAt: undefined,
            isBusy: false,
            isAttention: false,
            writeBuffer: '',
            writePending: false
        };

        if (pinned) {
            fetch(`/api/terminals/${paneId}/pin`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pinned: true })
            }).catch(err => console.error('[term] Failed to sync pin on backend:', err));
        }
        
        ws = new PTYWebSocket(
            paneId,
            (data) => { this.writeToTerminal(tabInfo, data); },
            (control) => { console.log("[ws] Received control:", control); },
            () => {
                term.write('\r\n\x1b[31m[Connection lost]\x1b[0m\r\n');
                tabInfo.isDead = true;
                tabEl.classList.add('dead');
                this._showReconnectOverlay(tabInfo);
            }
        );
        
        tabInfo.ws = ws;
        this.tabs.set(paneId, tabInfo);
        
        // Direct writing bridge — routes through tabInfo.ws so reconnect can swap the socket
        term.onData((data) => {
            if (tabInfo.directMode && !tabInfo.isDead) {
                tabInfo.ws.sendInput(data);
                if (data.includes('\r')) this._spamScrollToBottom(tabInfo);
            }
        });
        
        // Double click terminal → toggle direct focus mode
        termContainer.addEventListener('dblclick', (e) => {
            e.preventDefault();
            const tab = this.tabs.get(paneId);
            if (tab) {
                // 1. Capture scroll state BEFORE any focus or UI changes
                const buffer = tab.term.buffer.active;
                tab.isAtBottom = buffer.viewportY >= buffer.baseY - 1;
                tab.lastScrollY = buffer.viewportY;
                
                // 2. Toggle mode
                tab.directMode = !tab.directMode;
                
                // 3. Focus first so focus-induced browser scroll resets are captured
                if (tab.directMode) {
                    term.focus();
                } else {
                    this.inputTextArea.focus({ preventScroll: true });
                }
                
                // 4. Update UI and fit (which will restore the scroll perfectly)
                this.updateDirectModeUI(tab);
            }
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
            prevTab.isAtBottom = prevTab.term.buffer.active.viewportY >= prevTab.term.buffer.active.baseY - 1;
            prevTab.lastScrollY = prevTab.term.buffer.active.viewportY;
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
        
        // Update sidebar select state and active coder tab
        this.app.sessionsManager.switchCoder(newTab.coder);
        this.app.sessionsManager.highlightActiveSession(newTab.sessionId);
        
        // Sync project / workspace context from the tab
        if (newTab.workspace && this.app.sessionsManager.activeWorkspace !== newTab.workspace) {
            this.app.sessionsManager.workspaceSelect.value = newTab.workspace;
            this.app.sessionsManager.activeWorkspace = newTab.workspace;
            this.app.sessionsManager.activeCWD = newTab.cwd;
            this.app.sessionsManager.loadWorktrees().then(() => {
                this.app.sessionsManager.highlightActiveWorktree(newTab.cwd);
                this.app.diffController.refreshDiff();
                if (this.app.markdownManager) {
                    this.app.markdownManager.refreshFiles();
                }
            });
        } else if (newTab.cwd && this.app.sessionsManager.activeCWD !== newTab.cwd) {
            this.app.sessionsManager.activeCWD = newTab.cwd;
            this.app.sessionsManager.highlightActiveWorktree(newTab.cwd);
            this.app.diffController.refreshDiff();
            if (this.app.markdownManager) {
                this.app.markdownManager.refreshFiles();
            }
        }
        
        // Trigger resize calculation
        setTimeout(() => {
            this.fitActiveTerminal();
        }, 50);
    }
    
    togglePinTab(paneId) {
        const tab = this.tabs.get(paneId);
        if (!tab) return;
        
        tab.pinned = !tab.pinned;
        if (tab.pinned) {
            tab.tabEl.classList.add('pinned');
        } else {
            tab.tabEl.classList.remove('pinned');
        }
        
        // Sync with backend API.
        this.syncBackendPin(paneId, tab.pinned);
        
        this.saveTabsState();
    }

    syncBackendPin(paneId, pinned) {
        fetch(`/api/terminals/${paneId}/pin`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pinned: pinned })
        }).catch(err => console.error('[term] Failed to sync pin on backend:', err));
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
        this._spamScrollToBottom(activeTab);

        // Auto sync clipboard on /copy command
        if (val.includes('/copy')) {
            setTimeout(() => {
                this.app.syncRemoteClipboard();
            }, 300);
        }
        
        this.inputTextArea.focus({ preventScroll: true });
    }
    
    sendRawInput(bytes) {
        const activeTab = this.getActiveTab();
        if (!activeTab || activeTab.isDead) return;
        // The backend PTY layer handles the Windows ConPTY quirk where a \r
        // bundled with preceding text fails to register as Enter — see pkg/pty.
        activeTab.ws.sendInput(bytes);
        this.focusActiveTerminal();
        this._spamScrollToBottom(activeTab);

        // Auto sync clipboard on /copy command
        if (bytes.includes('/copy')) {
            setTimeout(() => {
                this.app.syncRemoteClipboard();
            }, 300);
        }
    }
    
    _showReconnectOverlay(tabInfo) {
        const existing = tabInfo.termContainer.querySelector('.reconnect-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.className = 'reconnect-overlay';
        overlay.innerHTML = `
            <div class="reconnect-box">
                <span class="reconnect-msg">session ended</span>
                <button class="reconnect-btn">⟳ Reconnect</button>
            </div>`;
        overlay.querySelector('.reconnect-btn').addEventListener('click', () => {
            this.reconnectTab(tabInfo);
        });
        tabInfo.termContainer.appendChild(overlay);
    }

    reconnectTab(tabInfo) {
        const overlay = tabInfo.termContainer.querySelector('.reconnect-overlay');
        const msgEl = overlay?.querySelector('.reconnect-msg');
        const btnEl = overlay?.querySelector('.reconnect-btn');

        if (msgEl) msgEl.innerText = 'connecting…';
        if (btnEl) btnEl.disabled = true;

        if (tabInfo.ws) try { tabInfo.ws.close(); } catch(e) {}

        let opened = false;
        const newWs = new PTYWebSocket(
            tabInfo.paneId,
            (data) => { this.writeToTerminal(tabInfo, data); },
            null,
            () => {
                if (!opened) {
                    if (msgEl) msgEl.innerText = 'session expired';
                    if (btnEl) { btnEl.disabled = false; btnEl.innerText = '⟳ Retry'; }
                } else {
                    tabInfo.isDead = true;
                    tabInfo.tabEl.classList.add('dead');
                    this._showReconnectOverlay(tabInfo);
                }
            },
            () => {
                opened = true;
                tabInfo.isDead = false;
                tabInfo.tabEl.classList.remove('dead');
                if (overlay) overlay.remove();
                tabInfo.term.write('\r\n\x1b[32m[Reconnected]\x1b[0m\r\n');
                setTimeout(() => this.sendResizeToBackend(tabInfo), 100);
            }
        );
        tabInfo.ws = newWs;
    }

    _spamScrollToBottom(tabInfo) {
        if (!tabInfo || tabInfo.isDead) return;
        clearInterval(tabInfo.spamInterval);
        clearTimeout(tabInfo.stopSpamTimeout);
        tabInfo.spamInterval = setInterval(() => tabInfo.term.scrollToBottom(), 10);
        tabInfo.stopSpamTimeout = setTimeout(() => {
            clearInterval(tabInfo.spamInterval);
            tabInfo.spamInterval = null;
            tabInfo.stopSpamTimeout = null;
            tabInfo.term.scrollToBottom();
        }, 300);
    }

    fitActiveTerminal() {
        const activeTab = this.getActiveTab();
        if (!activeTab || activeTab.isDead) return;
        
        try {
            // Capture scroll state PRE-FIT
            const buffer = activeTab.term.buffer.active;
            const isAtBottom = activeTab.isAtBottom !== undefined ? activeTab.isAtBottom : (buffer.viewportY >= buffer.baseY - 1);
            const scrollY = activeTab.lastScrollY !== undefined ? activeTab.lastScrollY : buffer.viewportY;
            
            activeTab.fitAddon.fit();
            
            // Restore scroll state POST-FIT
            // Brute-force spinlock scroll-spam BRRRRRR for 300ms
            if (!activeTab.spamInterval) {
                activeTab.spamInterval = setInterval(() => {
                    if (isAtBottom) {
                        activeTab.term.scrollToBottom();
                    } else {
                        activeTab.term.scrollToLine(scrollY);
                    }
                }, 10);
            }
            
            if (activeTab.stopSpamTimeout) {
                clearTimeout(activeTab.stopSpamTimeout);
            }
            
            activeTab.stopSpamTimeout = setTimeout(() => {
                clearInterval(activeTab.spamInterval);
                activeTab.spamInterval = null;
                activeTab.stopSpamTimeout = null;
                if (isAtBottom) {
                    activeTab.term.scrollToBottom();
                } else {
                    activeTab.term.scrollToLine(scrollY);
                }
            }, 300);
            
            // Clear temporary saved scroll state
            activeTab.isAtBottom = undefined;
            activeTab.lastScrollY = undefined;
            
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
    
    _toggleDropup(dropupId, triggerBtn, renderFn) {
        const dropup = document.getElementById(dropupId);
        if (!dropup) return;
        const wasHidden = dropup.classList.contains('hidden');
        document.querySelectorAll('.model-presets-dropup').forEach(d => d.classList.add('hidden'));
        if (wasHidden) {
            const btnRect = triggerBtn.getBoundingClientRect();
            const containerRect = document.querySelector('.terminal-content').getBoundingClientRect();
            dropup.style.left = `${btnRect.left - containerRect.left}px`;
            dropup.classList.remove('hidden');
            renderFn();
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
        
        // 2. Render Divider if static presets exist
        if (hasCoderPresets) {
            const divider = document.createElement('div');
            divider.className = 'presets-divider';
            this.presetsContainer.appendChild(divider);
        }
        
        // 3. Render QuickCmds trigger button
        const quickCmdsTriggerBtn = document.createElement('button');
        quickCmdsTriggerBtn.className = 'preset-btn model-trigger-btn';
        quickCmdsTriggerBtn.innerText = '⚡ Cmds ▾';
        quickCmdsTriggerBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._toggleDropup('quick-commands-dropup', quickCmdsTriggerBtn, () => this.renderQuickCmdsDropup());
        });
        this.presetsContainer.appendChild(quickCmdsTriggerBtn);

        // 4. Render Models trigger button
        const modelsTriggerBtn = document.createElement('button');
        modelsTriggerBtn.className = 'preset-btn model-trigger-btn';
        modelsTriggerBtn.innerText = '🤖 Models ▾';
        modelsTriggerBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._toggleDropup('model-presets-dropup', modelsTriggerBtn, () => this.renderModelDropup());
        });
        this.presetsContainer.appendChild(modelsTriggerBtn);

        // Auto-refresh dropup content if currently open
        const dropup = document.getElementById('model-presets-dropup');
        if (dropup && !dropup.classList.contains('hidden')) {
            this.renderModelDropup();
        }
        const qcDropup = document.getElementById('quick-commands-dropup');
        if (qcDropup && !qcDropup.classList.contains('hidden')) {
            this.renderQuickCmdsDropup();
        }
    }
    
    renderModelDropup() {
        const dropup = document.getElementById('model-presets-dropup');
        if (!dropup) return;
        dropup.innerHTML = '';
        
        const activeTab = this.getActiveTab();
        if (!activeTab) return;
        
        const backend = activeTab.coder;
        const allPresets = this.app.modelPresets || {};
        const modelPresets = allPresets[backend] || [];
        
        // 1. Header
        const header = document.createElement('div');
        header.className = 'dropup-header';
        header.innerText = 'Model Presets';
        dropup.appendChild(header);
        
        // 2. Render preset rows
        modelPresets.forEach(model => {
            const row = document.createElement('div');
            row.className = 'dropup-row';
            
            const btn = document.createElement('button');
            btn.className = 'dropup-model-btn';
            btn.innerText = model;
            btn.addEventListener('click', () => {
                this.sendRawInput(`/model ${model}\r`);
                dropup.classList.add('hidden');
            });
            row.appendChild(btn);
            
            const delBtn = document.createElement('button');
            delBtn.className = 'dropup-del-btn';
            delBtn.innerHTML = '×';
            delBtn.title = `Delete model preset ${model}`;
            delBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (confirm(`Remove model preset "${model}"?`)) {
                    try {
                        await fetch('/api/config/models', {
                            method: 'DELETE',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ model, coder: backend })
                        });
                        await this.app.sessionsManager.loadConfig();
                    } catch (err) {
                        console.error("Failed to delete model preset:", err);
                    }
                }
            });
            row.appendChild(delBtn);
            dropup.appendChild(row);
        });
        
        // 3. Add Preset Action Row
        const addRow = document.createElement('div');
        addRow.className = 'dropup-add-row';
        
        const addBtn = document.createElement('button');
        addBtn.className = 'dropup-add-btn';
        addBtn.innerText = '+ Add Model Preset...';
        addBtn.addEventListener('click', async () => {
            const model = prompt("Enter model name (e.g. deepseek/deepseek-v4-flash):");
            if (model && model.trim()) {
                try {
                    await fetch('/api/config/models', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ model: model.trim(), coder: backend })
                    });
                    await this.app.sessionsManager.loadConfig();
                } catch (err) {
                    console.error("Failed to add model preset:", err);
                }
            }
        });
        addRow.appendChild(addBtn);
        dropup.appendChild(addRow);
    }

    renderQuickCmdsDropup() {
        const dropup = document.getElementById('quick-commands-dropup');
        if (!dropup) return;
        dropup.innerHTML = '';

        const quickCmds = this.app.quickCommands || [];

        const header = document.createElement('div');
        header.className = 'dropup-header';
        header.innerText = 'Quick Commands';
        dropup.appendChild(header);

        quickCmds.forEach(cmd => {
            const row = document.createElement('div');
            row.className = 'dropup-row';

            const btn = document.createElement('button');
            btn.className = 'dropup-model-btn';
            btn.innerText = cmd.name;
            btn.title = cmd.command;
            btn.addEventListener('click', () => {
                const activeTab = this.getActiveTab();
                if (!activeTab || activeTab.isDead) return;
                const prefix = this.inputTextArea.value.trim();
                const combined = prefix && cmd.command.includes('{}')
                    ? cmd.command.replace('{}', prefix)
                    : prefix ? `${prefix} ${cmd.command}` : cmd.command;
                let payload = combined;
                if (combined.length > 16 || combined.includes('\n')) {
                    payload = '\x1b[200~' + combined + '\x1b[201~';
                }
                activeTab.ws.sendInput(payload + '\r');
                this.inputTextArea.value = '';
                this.inputTextArea.focus({ preventScroll: true });
                this._spamScrollToBottom(activeTab);
                dropup.classList.add('hidden');
            });
            row.appendChild(btn);

            const delBtn = document.createElement('button');
            delBtn.className = 'dropup-del-btn';
            delBtn.innerHTML = '×';
            delBtn.title = `Delete quick command "${cmd.name}"`;
            delBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (confirm(`Remove quick command "${cmd.name}"?`)) {
                    try {
                        await fetch('/api/config/quick-commands', {
                            method: 'DELETE',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ name: cmd.name })
                        });
                        await this.app.sessionsManager.loadConfig();
                    } catch (err) {
                        console.error("Failed to delete quick command:", err);
                    }
                }
            });
            row.appendChild(delBtn);
            dropup.appendChild(row);
        });

        const addRow = document.createElement('div');
        addRow.className = 'dropup-add-row';

        const addBtn = document.createElement('button');
        addBtn.className = 'dropup-add-btn';
        addBtn.innerText = '+ Add Command...';
        addBtn.addEventListener('click', async () => {
            const name = prompt("Command label (e.g. tests):");
            if (!name || !name.trim()) return;
            const command = prompt(`Command to send for "${name.trim()}" (e.g. npm test):`);
            if (!command || !command.trim()) return;
            try {
                await fetch('/api/config/quick-commands', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: name.trim(), command: command.trim() })
                });
                await this.app.sessionsManager.loadConfig();
            } catch (err) {
                console.error("Failed to add quick command:", err);
            }
        });
        addRow.appendChild(addBtn);
        dropup.appendChild(addRow);
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

    pollTerminalIdleAndNotifications() {
        const isTabVisible = !document.hidden;

        for (const tab of this.tabs.values()) {
            if (tab.isDead) continue;

            const isActiveAndVisible = (tab.paneId === this.activePaneId) && isTabVisible;

            // If the tab is currently focused and visible, clear attention states immediately.
            if (isActiveAndVisible) {
                if (tab.isAttention) {
                    tab.isAttention = false;
                    tab.tabEl.classList.remove('has-attention');
                    this.updateDocumentTitle();
                }
            }

            // Track busy-to-idle transition for active terminal connections.
            if (tab.isBusy && tab.lastOutputAt !== undefined) {
                const idleTime = Date.now() - tab.lastOutputAt;
                if (idleTime > 3000) {
                    // Output has stopped for 3 seconds. The PTY transitioned to idle!
                    tab.isBusy = false;

                    // Release backend pin if NOT manually pinned by the user.
                    if (!tab.pinned) {
                        this.syncBackendPin(tab.paneId, false);
                    }

                    // Only notify if this tab is NOT currently active and focused.
                    if (!isActiveAndVisible) {
                        let promptDetected = false;
                        if (tab.term && tab.term.buffer && tab.term.buffer.active) {
                            const buffer = tab.term.buffer.active;
                            const line = buffer.getLine(buffer.cursorY + buffer.baseY);
                            const text = line ? line.translateToString(true) : '';
                            const promptRe = /[$>❯…╰─]|agy>|opencode>/;
                            promptDetected = promptRe.test(text);
                        }

                        // Trigger attention indicator.
                        tab.isAttention = true;
                        tab.tabEl.classList.add('has-attention');
                        this.updateDocumentTitle();

                        // Escalate with notification chimes and browser popups.
                        this.triggerAttentionNotification(tab, promptDetected);
                    }
                }
            }
        }
    }

    updateDocumentTitle() {
        let anyAttention = false;
        for (const tab of this.tabs.values()) {
            if (tab.isAttention) {
                anyAttention = true;
                break;
            }
        }

        const cleanTitle = document.title.startsWith('● ') ? document.title.substring(2) : document.title;
        if (anyAttention) {
            document.title = '● ' + cleanTitle;
        } else {
            document.title = cleanTitle;
        }
    }

    triggerAttentionNotification(tab, promptDetected) {
        const message = promptDetected
            ? `Session "${tab.title}" is waiting at a prompt.`
            : `Session "${tab.title}" completed execution.`;

        // 1. Show in-app toast notification.
        if (this.app && typeof this.app.showToast === 'function') {
            this.app.showToast(message, {
                title: 'Task Done',
                type: 'info',
                duration: 6000
            });
        }

        // 2. Play subtle chime if backgrounded.
        const bellAudio = new Audio('vendor/bell.wav');
        bellAudio.volume = 0.2;
        bellAudio.play().catch(() => {});

        // 3. Show OS-level notification if tab is hidden / not active.
        if (document.hidden && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            try {
                const n = new Notification('Phi Session Done', {
                    body: message,
                    tag: 'phi-pane-' + tab.paneId,
                    icon: 'screenshot.png',
                    silent: true
                });
                n.onclick = () => {
                    window.focus();
                    this.switchTab(tab.paneId);
                    n.close();
                };
            } catch (e) {
                console.error('[notification] Failed to show OS notification:', e);
            }
        }
    }

    clearAttentionIndicators() {
        // Restore document title.
        if (document.title.startsWith('● ')) {
            document.title = document.title.substring(2);
        }
        
        // Clear isAttention flags.
        for (const tab of this.tabs.values()) {
            if (tab.isAttention) {
                tab.isAttention = false;
                tab.tabEl.classList.remove('has-attention');
            }
        }
    }
}
