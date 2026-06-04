/* Φ phi — Terminal & Tab Manager */

import { PTYWebSocket } from './ws.js';

const CODER_FAVICONS = {
    'opencode': 'https://www.google.com/s2/favicons?domain=opencode.ai&sz=64',
    'claude': 'https://www.google.com/s2/favicons?domain=claude.ai&sz=64',
    'agy': 'https://www.google.com/s2/favicons?domain=antigravity.google&sz=64',
    'pi': 'https://www.google.com/s2/favicons?domain=pi.dev&sz=64',
    'bash': 'https://www.google.com/s2/favicons?domain=iterm2.com&sz=64',
    'review': 'https://www.google.com/s2/favicons?domain=wikipedia.org&sz=64'
};

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
        this.ctrlTBtn = document.getElementById('ctrl-t-btn');
        this.lastInputValue = '';
        
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
        document.addEventListener('keydown', (e) => this.handleGlobalTabShortcuts(e));

        // Click/focus input bar → exit direct mode
        this.inputTextArea.addEventListener('focus', () => {
            const activeTab = this.getActiveTab();
            if (activeTab && activeTab.directMode) {
                activeTab.directMode = false;
                this.updateDirectModeUI(activeTab);
            }
        });

        // Trigger spam scroll on transition from empty to typed content
        this.inputTextArea.addEventListener('input', () => {
            const currentVal = this.inputTextArea.value;
            if (this.lastInputValue === '' && currentVal !== '') {
                const activeTab = this.getActiveTab();
                if (activeTab) {
                    this._spamScrollToBottom(activeTab);
                }
            }
            this.lastInputValue = currentVal;
        });

        // Staged input send on Enter
        this.inputTextArea.addEventListener('keydown', (e) => {
            // When input is empty, capture arrows, enter, escape and ctrl key shortcuts to control PTY directly.
            if (this.inputTextArea.value === '') {
                // Capture Shift+Tab (Backtab) to prevent browser focus shift
                if (e.key === 'Tab' && e.shiftKey) {
                    e.preventDefault();
                    const activeTab = this.getActiveTab();
                    if (activeTab && !activeTab.isDead) {
                        activeTab.ws.sendInput('\x1b[Z');
                        this._spamScrollToBottom(activeTab);
                    }
                    return;
                }

                const keys = {
                    'ArrowUp': '\u001b[A',
                    'ArrowDown': '\u001b[B',
                    'ArrowLeft': '\u001b[D',
                    'ArrowRight': '\u001b[C',
                    'PageUp': '\u001b[5~',
                    'PageDown': '\u001b[6~',
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
                        'p': '\x10',
                        't': '\x14'
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

        if (this.ctrlTBtn) {
            this.ctrlTBtn.addEventListener('click', () => {
                const activeTab = this.getActiveTab();
                if (activeTab && !activeTab.isDead) {
                    this.sendRawInput('\x14');
                    this.focusActiveTerminal();
                }
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
            this.startResize();
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(() => {
                this.fitActiveTerminal();
                this.endResize();
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

        if (tabInfo.loaderEl && !tabInfo.hasStarted) {
            tabInfo.hasStarted = true;
            const loader = tabInfo.loaderEl;
            loader.style.opacity = '0';
            setTimeout(() => {
                if (loader.parentNode) {
                    loader.remove();
                }
            }, 300);
            tabInfo.loaderEl = null;
        }

        tabInfo.writeBuffer += data;

        // Track PTY activity on output.
        tabInfo.lastOutputAt = Date.now();
        if (!tabInfo.isBusy) {
            tabInfo.isBusy = true;
            tabInfo.busyStartTime = Date.now();
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

        // Toggle Ctrl+T button visibility based on backend
        if (this.ctrlTBtn) {
            if (['opencode', 'pi'].includes(tab.coder)) {
                this.ctrlTBtn.classList.remove('hidden');
            } else {
                this.ctrlTBtn.classList.add('hidden');
            }
        }

        this.fitActiveTerminal();
    }
    
    createTab(paneId, sessionId, title, coder, workspace = '', cwd = '', pinned = false) {
        // If tab already exists, just switch to it
        if (this.tabs.has(paneId)) {
            this.switchTab(paneId);
            return;
        }
        
        const faviconUrl = CODER_FAVICONS[coder] || 'https://www.google.com/s2/favicons?domain=iterm2.com&sz=64';

        // Create elements
        const tabEl = document.createElement('div');
        tabEl.className = 'tab';
        if (pinned) tabEl.classList.add('pinned');
        tabEl.setAttribute('data-pane-id', paneId);
        tabEl.innerHTML = `
            <button class="tab-pin" title="Pin session (Keep alive overnight)">📌</button>
            <img class="tab-favicon" src="${faviconUrl}" alt="${coder}">
            <span class="tab-title">${title}</span>
            <button class="tab-close">×</button>
        `;
        
        const termContainer = document.createElement('div');
        termContainer.className = 'term-container';
        termContainer.id = `term-${paneId}`;
        
        let loaderEl = null;
        if (coder !== 'review') {
            loaderEl = document.createElement('div');
            loaderEl.className = 'tab-loader';
            loaderEl.innerHTML = `
                <div class="spinner-ring"></div>
                <div class="loader-text">Starting ${title}...</div>
            `;
            termContainer.appendChild(loaderEl);
        }

        this.tabsContainer.appendChild(tabEl);
        this.terminalsWrapper.appendChild(termContainer);
        
        // Clean up the initial loader placeholder if it exists on first tab creation
        const loader = this.terminalsWrapper.querySelector('#initial-loader');
        if (loader) loader.remove();
        
        tabEl.addEventListener('click', (e) => {
            const currentPaneId = tabEl.getAttribute('data-pane-id');
            if (e.target.closest('.tab-close')) {
                e.stopPropagation();
                this.closeTab(currentPaneId);
            } else if (e.target.closest('.tab-pin')) {
                e.stopPropagation();
                this.togglePinTab(currentPaneId);
            } else {
                this.switchTab(currentPaneId);
            }
        });

        if (coder === 'review') {
            termContainer.classList.add('review-panel');
            const tabInfo = {
                paneId,
                sessionId,
                title,
                coder,
                workspace,
                cwd,
                tabEl,
                termContainer,
                isDead: true,
                isReview: true,
                pinned: !!pinned
            };
            this.tabs.set(paneId, tabInfo);
            this.switchTab(paneId);
            return;
        }
        
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

        // Register OSC 52 clipboard handler
        if (term.parser && term.parser.registerOscHandler) {
            term.parser.registerOscHandler(52, (data) => {
                const parts = data.split(';');
                if (parts.length < 2) return true;
                const base64Text = parts[1].replace(/[^A-Za-z0-9+/=]/g, '');
                if (base64Text === '?') return true;
                try {
                    const binaryString = atob(base64Text);
                    const bytes = new Uint8Array(binaryString.length);
                    for (let i = 0; i < binaryString.length; i++) {
                        bytes[i] = binaryString.charCodeAt(i);
                    }
                    const text = new TextDecoder('utf-8').decode(bytes);
                    navigator.clipboard.writeText(text).then(() => {
                        this.app.showToast(`Agent copied ${text.length} characters to clipboard`, { type: 'info', title: 'Clipboard Sync' });
                    }).catch(err => {
                        this.app.showToast(`Agent copied ${text.length} characters`, {
                            type: 'info',
                            title: 'Clipboard Sync',
                            duration: 15000,
                            action: {
                                text: 'Copy to Clipboard',
                                callback: async () => {
                                    try {
                                        await navigator.clipboard.writeText(text);
                                        this.app.showToast("Copied to clipboard!", { type: 'info', title: 'Clipboard Sync' });
                                    } catch (e) {
                                        this.app.showToast("Failed to copy. Please copy manually.", { type: 'error', title: 'Clipboard Sync' });
                                    }
                                }
                            }
                        });
                    });
                } catch (e) {
                    console.error("OSC 52 decode error:", e);
                }
                return true;
            });
        }
        
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
        termContainer.addEventListener('contextmenu', (e) => {
            const sel = term.getSelection();
            if (!sel) return;
            e.preventDefault();
            e.stopPropagation();
            this.copyTextRobustly(sel);
        }, { capture: true });

        term.attachCustomKeyEventHandler((e) => {
            if (e.type === 'keydown') {
                const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
                const isCopy = (isMac && e.metaKey && e.key.toLowerCase() === 'c') || 
                               (!isMac && e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'c');
                if (isCopy) {
                    const sel = term.getSelection();
                    if (sel) {
                        this.copyTextRobustly(sel);
                        e.preventDefault();
                        return false;
                    }
                }
            }
            // Support Alt+1..9 tab switching inside xterm
            if (e.altKey && e.key >= '1' && e.key <= '9') {
                if (e.type === 'keydown') {
                    this.handleGlobalTabShortcuts(e);
                }
                return false;
            }
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

        term.onSelectionChange(() => {
            const sel = term.getSelection();
            if (sel) {
                this.copyTextRobustly(sel, true);
            }
        });
        
        // Opencode scroll fix: intercept in capture phase before xterm.js can consume the event
        // Scoped strictly to opencode tabs – all other coders pass through untouched
        termContainer.addEventListener('wheel', (e) => {
            if (tabInfo.coder !== 'opencode') return;

            const isUp = e.deltaY < 0;

            // Scale scroll amount from the wheel delta for natural-feeling speed
            // Math.abs(deltaY) is typically ~100 for a single notch; clamp to a sane range
            const lines = Math.max(1, Math.min(Math.round(Math.abs(e.deltaY) / 40), 8));

            if (term.buffer.active.type === 'alternate') {
                // Alternate screen: send Ctrl+Alt+Y / Ctrl+Alt+E sequences to the TUI
                // These keys scroll the chat viewport up/down one line
                e.preventDefault();
                e.stopPropagation();
                const seq = isUp ? '\x1b\x19' : '\x1b\x05';
                const payload = seq.repeat(lines);
                if (tabInfo.ws && !tabInfo.isDead) {
                    tabInfo.ws.sendInput(payload);
                }
            } else {
                // Normal screen: scroll the xterm viewport directly
                e.preventDefault();
                e.stopPropagation();
                term.scrollLines(isUp ? -lines : lines);
            }
        }, { capture: true, passive: false });
        
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
        
        // Load Unicode 11 Addon for correct emoji cell width measurements
        try {
            const unicode11 = new window.Unicode11Addon.Unicode11Addon();
            term.loadAddon(unicode11);
            term.unicode.activeVersion = '11';
            console.log("[term] Loaded Unicode 11 character width addon");
        } catch (e) {
            console.warn("[term] Failed to load Unicode 11 addon:", e);
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
            writePending: false,
            loaderEl: loaderEl,
            hasStarted: false
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
            const tab = tabInfo;
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
            if (prevTab.term) {
                prevTab.isAtBottom = prevTab.term.buffer.active.viewportY >= prevTab.term.buffer.active.baseY - 1;
                prevTab.lastScrollY = prevTab.term.buffer.active.viewportY;
            }
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
        if (newTab.coder === 'review') {
            this.inputBarContainer.classList.add('hidden');
        } else {
            this.inputBarContainer.classList.remove('hidden');
            this.updateDirectModeUI(newTab);
        }
        
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
        this.lastInputValue = '';
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
                <div class="reconnect-buttons">
                    <button class="reconnect-btn">⟳ Reconnect</button>
                    <button class="restart-btn">⚡ Restart</button>
                </div>
            </div>`;

        overlay.querySelector('.reconnect-btn').addEventListener('click', () => {
            this.reconnectTab(tabInfo);
        });
        overlay.querySelector('.restart-btn').addEventListener('click', () => {
            this.restartTab(tabInfo);
        });

        tabInfo.termContainer.appendChild(overlay);
    }

    reconnectTab(tabInfo) {
        const overlay = tabInfo.termContainer.querySelector('.reconnect-overlay');
        const msgEl = overlay?.querySelector('.reconnect-msg');
        const btnEl = overlay?.querySelector('.reconnect-btn');
        const restartBtn = overlay?.querySelector('.restart-btn');

        if (msgEl) msgEl.innerText = 'connecting…';
        if (btnEl) btnEl.disabled = true;
        if (restartBtn) restartBtn.disabled = true;

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
                    if (restartBtn) restartBtn.disabled = false;
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

    restartTab(tabInfo) {
        const overlay = tabInfo.termContainer.querySelector('.reconnect-overlay');
        const msgEl = overlay?.querySelector('.reconnect-msg');
        const reconnectBtn = overlay?.querySelector('.reconnect-btn');
        const restartBtn = overlay?.querySelector('.restart-btn');

        if (msgEl) msgEl.innerText = 'restarting…';
        if (reconnectBtn) reconnectBtn.disabled = true;
        if (restartBtn) restartBtn.disabled = true;

        if (tabInfo.ws) try { tabInfo.ws.close(); } catch(e) {}

        fetch('/api/terminals', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                coder: tabInfo.coder,
                cwd: tabInfo.cwd,
                session_id: tabInfo.sessionId || ''
            })
        })
        .then(res => {
            if (!res.ok) throw new Error('failed to spawn restarted session');
            return res.json();
        })
        .then(data => {
            const oldPaneId = tabInfo.paneId;
            
            // Update paneId and sessionId
            tabInfo.paneId = data.pane_id;
            tabInfo.sessionId = data.session_id;
            
            // Update DOM element references to synchronise new IDs
            tabInfo.tabEl.setAttribute('data-pane-id', data.pane_id);
            tabInfo.termContainer.id = `term-${data.pane_id}`;
            
            // Update TabManager map tracking
            this.tabs.delete(oldPaneId);
            this.tabs.set(data.pane_id, tabInfo);
            
            if (this.activePaneId === oldPaneId) {
                this.activePaneId = data.pane_id;
            }
            
            // Reset terminal screen and print visual cue
            tabInfo.term.reset();
            tabInfo.term.write('\x1b[2J\x1b[H\r\n\x1b[33m[Restarted Session]\x1b[0m\r\n');

            let opened = false;
            const newWs = new PTYWebSocket(
                tabInfo.paneId,
                (msg) => { this.writeToTerminal(tabInfo, msg); },
                null,
                () => {
                    if (!opened) {
                        if (msgEl) msgEl.innerText = 'session expired';
                        if (reconnectBtn) reconnectBtn.disabled = false;
                        if (restartBtn) restartBtn.disabled = false;
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
                    
                    // Trigger terminal fit & backend resize to synchronise viewport
                    setTimeout(() => {
                        this.fitActiveTerminal();
                        this.sendResizeToBackend(tabInfo);
                    }, 100);
                }
            );
            tabInfo.ws = newWs;
            
            // Sync with session list in sidebar
            if (this.app.sessionsManager) {
                this.app.sessionsManager.loadSessions();
            }
        })
        .catch(err => {
            console.error('[restart] Failed to restart tab:', err);
            if (msgEl) msgEl.innerText = 'restart failed';
            if (reconnectBtn) reconnectBtn.disabled = false;
            if (restartBtn) restartBtn.disabled = false;
        });
    }

    handleGlobalTabShortcuts(e) {
        if (e.altKey && !e.ctrlKey && !e.metaKey && e.key >= '1' && e.key <= '9') {
            const num = parseInt(e.key, 10);
            const paneIds = Array.from(this.tabs.keys());
            if (paneIds.length === 0) return;

            e.preventDefault();
            
            let targetPaneId;
            if (num === 9) {
                // Alt+9 switches to the last tab
                targetPaneId = paneIds[paneIds.length - 1];
            } else {
                // Alt+1 to Alt+8 switch to corresponding index
                const idx = num - 1;
                if (idx < paneIds.length) {
                    targetPaneId = paneIds[idx];
                }
            }

            if (targetPaneId !== undefined) {
                this.switchTab(targetPaneId);
            }
        }
    }

    _spamScroll(tabInfo, isAtBottom, scrollY = null) {
        if (!tabInfo || tabInfo.isDead) return;
        
        clearInterval(tabInfo.spamInterval);
        clearTimeout(tabInfo.stopSpamTimeout);
        
        tabInfo.spamInterval = setInterval(() => {
            if (isAtBottom) {
                tabInfo.term.scrollToBottom();
            } else if (scrollY !== null) {
                tabInfo.term.scrollToLine(scrollY);
            }
        }, 10);
        
        tabInfo.stopSpamTimeout = setTimeout(() => {
            clearInterval(tabInfo.spamInterval);
            tabInfo.spamInterval = null;
            tabInfo.stopSpamTimeout = null;
            if (isAtBottom) {
                tabInfo.term.scrollToBottom();
            } else if (scrollY !== null) {
                tabInfo.term.scrollToLine(scrollY);
            }
        }, 300);
    }

    _spamScrollToBottom(tabInfo) {
        this._spamScroll(tabInfo, true);
    }

    copyTextRobustly(text, silent = false) {
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(text).then(() => {
                if (!silent) {
                    this.app.showToast("Copied to clipboard", { type: 'info', title: 'Clipboard' });
                }
            }).catch(() => this.fallbackCopy(text, silent));
        } else {
            this.fallbackCopy(text, silent);
        }
    }

    fallbackCopy(text, silent = false) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        let success = false;
        try {
            success = document.execCommand('copy');
            if (success && !silent) {
                this.app.showToast("Copied to clipboard", { type: 'info', title: 'Clipboard' });
            }
        } catch (e) {
            console.error("Fallback copy failed", e);
        }
        document.body.removeChild(ta);
        if (!success && !silent) {
            this.app.showToast("Failed to copy. Please copy manually.", { type: 'error', title: 'Clipboard' });
        }
    }

    startResize() {
        const activeTab = this.getActiveTab();
        if (!activeTab || activeTab.isDead) return;
        
        // Save the correct, stable scroll state before the continuous resize begins
        if (activeTab.isAtBottom === undefined) {
            const buffer = activeTab.term.buffer.active;
            activeTab.isAtBottom = buffer.viewportY >= buffer.baseY - 1;
            activeTab.lastScrollY = buffer.viewportY;
        }
        this.isResizing = true;
    }

    endResize() {
        this.isResizing = false;
        const activeTab = this.getActiveTab();
        if (activeTab) {
            activeTab.isAtBottom = undefined;
            activeTab.lastScrollY = undefined;
        }
    }

    fitActiveTerminal() {
        const activeTab = this.getActiveTab();
        if (!activeTab || activeTab.isDead) return;
        
        try {
            // Capture scroll state PRE-FIT
            const buffer = activeTab.term.buffer.active;
            const isAtBottom = activeTab.isAtBottom !== undefined ? activeTab.isAtBottom : (buffer.viewportY >= buffer.baseY - 1);
            const scrollY = activeTab.lastScrollY !== undefined ? activeTab.lastScrollY : buffer.viewportY;
            
            // If we are resizing continuously, cache these stable coordinates on the tab
            if (this.isResizing) {
                activeTab.isAtBottom = isAtBottom;
                activeTab.lastScrollY = scrollY;
            }

            activeTab.fitAddon.fit();
            
            // Restore scroll state POST-FIT using the unified helper to synchronise viewport
            this._spamScroll(activeTab, isAtBottom, scrollY);
            
            // Clear temporary saved scroll state only if NOT in the middle of a continuous resize
            if (!this.isResizing) {
                activeTab.isAtBottom = undefined;
                activeTab.lastScrollY = undefined;
            }
            
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
                    const activeTab = this.getActiveTab();
                    if (activeTab && activeTab.coder === 'opencode' && p.value.startsWith('/') && p.value.endsWith('\r')) {
                        const cmd = p.value.slice(0, -1);
                        this.sendRawInput(cmd);
                        setTimeout(() => {
                            this.sendRawInput('\r');
                        }, 350);
                    } else {
                        this.sendRawInput(p.value);
                    }
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
        const modelPresets = [...(allPresets[backend] || [])].sort((a, b) => a.localeCompare(b));
        
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
                if (backend === 'opencode') {
                    this.sendRawInput('/models\r');
                    setTimeout(() => {
                        this.sendRawInput(model);
                        setTimeout(() => {
                            this.sendRawInput('\r');
                        }, 350);
                    }, 350);
                } else {
                    this.sendRawInput(`/model ${model}\r`);
                }
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
                this.lastInputValue = '';
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

                    // Calculate total execution duration
                    const totalDuration = Date.now() - (tab.busyStartTime || Date.now());
                    const isLongTask = totalDuration > 8000;

                    // Only notify if this tab is NOT currently active and focused, and was a long-running task.
                    if (!isActiveAndVisible && isLongTask) {
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
