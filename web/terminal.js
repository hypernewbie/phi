/* Φ phi — Terminal & Tab Manager */

import { PTYWebSocket } from './ws.js';
import { normalizePath } from './sessions.js';
import { projectWorktreeLabel, cpuLevel } from './util.js';

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
        
        if (window.innerWidth <= 768 && this.inputTextArea) {
            this.inputTextArea.placeholder = "Type a prompt...";
        }

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
        // Also poll CPU stats independently so a stats fetch failure cannot
        // break the idle/notification path (CPU is decorative, never load-bearing).
        setInterval(() => {
            this.pollTerminalIdleAndNotifications();
        }, 1000);
        setInterval(() => {
            this.pollSystemCPU();
        }, 2000);
    }

    /**
     * Fetch current system CPU% from /api/system/cpu and update the phi
     * logo's CPU state class (.cpu-idle / .cpu-moderate / .cpu-high).
     *
     * Independent of the terminal idle poll — a fetch failure here
     * must NOT break anything else.
     */
    async pollSystemCPU() {
        try {
            const res = await fetch('/api/system/cpu');
            if (!res.ok) return;
            const data = await res.json();
            const cpu = typeof data.cpu === 'number' ? data.cpu : 0;
            this.applyCPUIndicator(cpu);
        } catch (e) {
            // Silent: decorative feature, never break anything.
        }
    }

    applyCPUIndicator(cpuPercent) {
        const logo = document.querySelector('.brand .logo');
        const brandName = document.querySelector('.brand .brand-name');
        if (!logo) return;
        // Thresholds: idle < 30, moderate 30–70, high 70-90, critical > 90
        const level = cpuLevel(cpuPercent);
        // Don't churn the DOM if the level hasn't changed
        if (logo.dataset.cpuLevel === level) return;
        for (const el of [logo, brandName]) {
            if (!el) continue;
            el.classList.remove('cpu-idle', 'cpu-moderate', 'cpu-high', 'cpu-critical');
            el.classList.add(level);
            el.dataset.cpuLevel = level;
        }
    }
    
    saveTabsState() {
        localStorage.setItem('phi_active_pane', this.activePaneId || '');
        // Tab order is localStorage-only (no backend sync). Drag-reorder
        // mutates the Map; saving the Map's iteration order here keeps the
        // ordering across page reloads in the same browser.
        this.saveTabOrder();
    }

    // The persisted order is a JSON array of paneIds. Stale entries
    // (closed tabs, or paneIds that were renamed during a session restart)
    // are filtered out at restore time - see restoreTabsState.
    saveTabOrder() {
        try {
            localStorage.setItem('phi_tab_order', JSON.stringify(Array.from(this.tabs.keys())));
        } catch (e) {
            // localStorage can throw in private-mode / quota-exceeded. Failing
            // to persist order shouldn't break tab switching - just log.
            console.warn('phi: failed to save tab order', e);
        }
    }

    // ---- Drag-to-reorder (localStorage-only, v0.8.x polish) ----

    applySavedTabOrder() {
        let saved = [];
        try {
            const raw = localStorage.getItem('phi_tab_order');
            if (raw) saved = JSON.parse(raw);
        } catch (e) {
            // Corrupted entry: just ignore and fall back to API order.
            return;
        }
        if (!Array.isArray(saved) || saved.length === 0) return;

        const present = new Set(this.tabs.keys());
        const filtered = saved.filter(id => present.has(id));
        // Any tabs not in the saved order get appended at the end in the
        // order they currently sit (preserves API order for newly-spawned
        // tabs that the user hasn't touched yet).
        const missing = Array.from(present).filter(id => !filtered.includes(id));
        const final = [...filtered, ...missing];
        if (final.length !== this.tabs.size) return; // safety
        this.applyTabOrder(final, { persist: false });
    }

    // Reorders both the tabs Map (which drives `this.tabs.keys()` iteration)
    // and the DOM (via appendChild, which moves existing nodes). When
    // `persist` is true, also writes the new order to localStorage.
    applyTabOrder(order, { persist = true } = {}) {
        // Rebuild the Map preserving the new order. TabInfo objects keep
        // their identity (same refs) - we're just rearranging the slots.
        const newMap = new Map();
        for (const id of order) {
            const tab = this.tabs.get(id);
            if (tab) newMap.set(id, tab);
        }
        // Defensive: any tab not in `order` (shouldn't happen) gets appended.
        for (const [id, tab] of this.tabs) {
            if (!newMap.has(id)) newMap.set(id, tab);
        }
        this.tabs = newMap;
        // Reorder DOM children - appendChild on an existing node moves it,
        // doesn't clone it. The terminal-content side (`terminalsWrapper`)
        // is untouched; only the tab strip is reordered.
        for (const id of order) {
            const tabEl = this.tabsContainer.querySelector(`[data-pane-id="${id}"]`);
            if (tabEl) this.tabsContainer.appendChild(tabEl);
        }
        if (persist) this.saveTabOrder();
    }

    // Splice `sourceId` into the order immediately before or after
    // `targetId`. Returns true if the order actually changed.
    moveTabTo(sourceId, targetId, before) {
        if (sourceId === targetId) return false;
        const order = Array.from(this.tabs.keys());
        const sourceIdx = order.indexOf(sourceId);
        const targetIdx = order.indexOf(targetId);
        if (sourceIdx < 0 || targetIdx < 0) return false;

        order.splice(sourceIdx, 1);
        // After removing source, if source was BEFORE target originally,
        // every later index shifted left by 1. Adjust the target's effective
        // index in the post-removal array before computing the insert slot.
        const targetIdxPost = targetIdx - (sourceIdx < targetIdx ? 1 : 0);
        const insertPos = targetIdxPost + (before ? 0 : 1);
        order.splice(insertPos, 0, sourceId);
        this.applyTabOrder(order);
        return true;
    }

    handleTabDragStart(e, paneId) {
        // Only honor left-button drags. Touch and right-click shouldn't
        // initiate a reorder - the latter opens the context menu (if any).
        if (e.button !== undefined && e.button !== 0) {
            e.preventDefault();
            return;
        }
        this.dragSourceId = paneId;
        try {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', paneId);
        } catch (_) { /* some browsers throw if dataTransfer is accessed oddly */ }
        // Use rAF so the drag image captures the un-faded tab.
        requestAnimationFrame(() => {
            const tabEl = this.tabsContainer.querySelector(`[data-pane-id="${paneId}"]`);
            if (tabEl) tabEl.classList.add('dragging');
        });
    }

    handleTabDragEnd(e) {
        const tabEl = e.currentTarget;
        if (tabEl) tabEl.classList.remove('dragging');
        this.clearDropIndicators();
        this.dragSourceId = null;
    }

    handleTabDragOver(e, targetPaneId) {
        if (!this.dragSourceId || this.dragSourceId === targetPaneId) return;
        // Pinned tabs aren't draggable so the source is never a pinned tab,
        // but the target might be (dropping next to a pinned tab is fine -
        // we just compute insert-before/after the pinned tab, and the move
        // logic naturally lands the non-pinned source after all pinned tabs).
        const tabEl = e.currentTarget;
        if (!tabEl || tabEl.classList.contains('pinned')) return;
        e.preventDefault(); // required so the `drop` event fires
        try { e.dataTransfer.dropEffect = 'move'; } catch (_) {}

        const rect = tabEl.getBoundingClientRect();
        const insertBefore = e.clientX < rect.left + rect.width / 2;
        this.showDropIndicator(tabEl, insertBefore);
    }

    handleTabDragLeave(e) {
        // Only clear when we leave the tab entirely (not when moving between
        // child elements within it - relatedTarget tells us where we went).
        const to = e.relatedTarget;
        if (to && e.currentTarget.contains(to)) return;
        const tabEl = e.currentTarget;
        tabEl.classList.remove('drop-before', 'drop-after');
    }

    handleTabDrop(e, targetPaneId) {
        e.preventDefault();
        const tabEl = e.currentTarget;
        const insertBefore = tabEl.classList.contains('drop-before');
        this.clearDropIndicators();
        if (!this.dragSourceId || this.dragSourceId === targetPaneId) {
            this.dragSourceId = null;
            return;
        }
        this.moveTabTo(this.dragSourceId, targetPaneId, insertBefore);
        this.dragSourceId = null;
    }

    showDropIndicator(tabEl, insertBefore) {
        // Drop indicators are box-shadow classes on the target tab itself
        // (so we never need to measure absolute positions in the scroll
        // container). Only one indicator at a time - clear before showing.
        this.clearDropIndicators();
        tabEl.classList.add(insertBefore ? 'drop-before' : 'drop-after');
    }

    clearDropIndicators() {
        for (const el of this.tabsContainer.querySelectorAll('.drop-before, .drop-after')) {
            el.classList.remove('drop-before', 'drop-after');
        }
    }

    async restoreTabsState() {
        localStorage.removeItem('phi_tabs'); // Clear legacy browser storage tabs
        try {
            const res = await fetch('/api/terminals');
            if (!res.ok) throw new Error("Failed to load server terminal list");
            const instances = await res.json();
            if (!instances || !instances.length) {
                this.showEmptyState();
            }

            const savedActive = localStorage.getItem('phi_active_pane') || '';
            for (const t of instances) {
                this.createTab(t.id, t.session_id, t.title || t.coder, t.coder, t.workspace || '', t.cwd || '', !!t.pinned, !!t.marked);
            }
            // Apply the user's drag-reorder (if any) from localStorage. Stale
            // paneIds (closed tabs, or IDs that changed during a session
            // restart) are dropped; new tabs not in the saved order are
            // appended at the end in their natural order.
            this.applySavedTabOrder();
            // BUG-2 fix: the kanban tab is client-only (no server-side terminal
            // entry), so restore it here if it was open when the page was
            // last reloaded. createTab short-circuits if it's already there.
            if (localStorage.getItem('phi_kanban_open') === '1') {
                await this.app.kanbanManager.openBoard();
                return;
            }
            if (savedActive && this.tabs.has(savedActive)) {
                this.switchTab(savedActive);
            } else if (instances.length > 0) {
                this.switchTab(instances[0].id);
            }
        } catch (e) {
            console.error("Failed to restore tabs from server-side state:", e);
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
            if (window.innerWidth <= 768) {
                // updateLayoutPosition already forces window.scrollTo(0,0) on
                // mobile to counteract iOS WebKit's focus-scroll behaviour.
                // Run it twice (now + 50ms) so we cover the keyboard-show
                // animation; the second pass is a defensive re-fit in case
                // the keyboard appeared with a delay.
                this.app.updateLayoutPosition?.(true);
                setTimeout(() => this.app.updateLayoutPosition?.(true), 50);
            }
        });

        this.inputTextArea.addEventListener('blur', () => {
            if (window.innerWidth <= 768) {
                // Same defensive re-fit on blur - keyboard is hiding, layout
                // needs to snap back to full height.
                setTimeout(() => this.app.updateLayoutPosition?.(true), 150);
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
            this.adjustInputHeight();
        });

        // Staged input send on Enter
        this.inputTextArea.addEventListener('keydown', (e) => {
            // When input is empty, capture arrows, enter, escape and ctrl key shortcuts to control PTY directly.
            if (this.inputTextArea.value === '') {
                // Capture Shift+Tab (Backtab) to prevent browser focus shift
                if (e.key === 'Tab' && e.shiftKey) {
                    e.preventDefault();
                    const activeTab = this.getActiveTab();
                    if (activeTab) {
                        this.sendInput(activeTab, '\x1b[Z');
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
                    'Escape': '\x1b',
                    'Backspace': '\x7f'
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
                    if (activeTab) {
                        this.sendInput(activeTab, sendChar);
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
                if (activeTab) {
                    this.sendRawInput('\x14');
                    this.focusActiveTerminal();
                }
            });
        }

        const closeAllBtn = document.getElementById('close-all-tabs-btn');
        const mobileCloseAllBtn = document.getElementById('mobile-close-all-tabs-btn');
        const handleCloseAll = () => {
            if (this.tabs.size === 0) return;
            if (confirm(`Are you sure you want to close all ${this.tabs.size} active sessions?`)) {
                const keys = Array.from(this.tabs.keys());
                keys.forEach(paneId => {
                    this.closeTab(paneId);
                });
                this.app.sessionsManager.loadSessions();
            }
        };
        closeAllBtn?.addEventListener('click', handleCloseAll);
        mobileCloseAllBtn?.addEventListener('click', handleCloseAll);

        const reconnectAllBtn = document.getElementById('reconnect-all-tabs-btn');
        const mobileReconnectAllBtn = document.getElementById('mobile-reconnect-all-tabs-btn');
        const handleReconnectAll = () => {
            this.reconnectAllDead();
        };
        reconnectAllBtn?.addEventListener('click', handleReconnectAll);
        mobileReconnectAllBtn?.addEventListener('click', handleReconnectAll);

        const refreshConsoleBtn = document.getElementById('refresh-console-btn');
        const mobileRefreshConsoleBtn = document.getElementById('mobile-refresh-console-btn');
        const handleRefreshConsole = () => {
            const activeTab = this.getActiveTab();
            if (!activeTab || !activeTab.term) return;
            activeTab.term.refresh(0, activeTab.term.rows - 1);
            this.activateTabViewport(activeTab, { scrollToBottom: true, autoReconnect: true });
        };
        refreshConsoleBtn?.addEventListener('click', handleRefreshConsole);
        mobileRefreshConsoleBtn?.addEventListener('click', handleRefreshConsole);
        
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

        const hostEl = document.getElementById('hostname-display');
        if (hostEl) {
            hostEl.addEventListener('click', (e) => {
                e.stopPropagation();
                const dropdown = document.getElementById('hostname-tabs-dropdown');
                if (dropdown) {
                    const isHidden = dropdown.classList.contains('hidden');
                    if (isHidden) {
                        this.renderHostnameTabsDropdown();
                        dropdown.classList.remove('hidden');
                    } else {
                        dropdown.classList.add('hidden');
                    }
                }
            });
        }

        // Close dropups and dropdowns on clicking outside
        document.addEventListener('click', (e) => {
            const modelDropup = document.getElementById('model-presets-dropup');
            if (modelDropup && !modelDropup.classList.contains('hidden')) {
                if (!e.target.closest('#model-presets-dropup') && !e.target.closest('.model-trigger-btn')) {
                    modelDropup.classList.add('hidden');
                }
            }
            
            const qcDropup = document.getElementById('quick-commands-dropup');
            if (qcDropup && !qcDropup.classList.contains('hidden')) {
                if (!e.target.closest('#quick-commands-dropup') && !e.target.closest('.model-trigger-btn')) {
                    qcDropup.classList.add('hidden');
                }
            }
            
            const slashDropup = document.getElementById('slash-presets-dropup');
            if (slashDropup && !slashDropup.classList.contains('hidden')) {
                if (!e.target.closest('#slash-presets-dropup') && !e.target.closest('.slash-trigger-btn')) {
                    slashDropup.classList.add('hidden');
                }
            }
            
            const hostDropdown = document.getElementById('hostname-tabs-dropdown');
            if (hostDropdown && !hostDropdown.classList.contains('hidden')) {
                if (!e.target.closest('#hostname-display') && !e.target.closest('#hostname-tabs-dropdown')) {
                    hostDropdown.classList.add('hidden');
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
    
    createTab(paneId, sessionId, title, coder, workspace = '', cwd = '', pinned = false, marked = false, initialCmd = '') {
        // If tab already exists, just switch to it
        if (this.tabs.has(paneId)) {
            this.switchTab(paneId, { userInitiated: true });
            return;
        }
        
        const faviconUrl = CODER_FAVICONS[coder] || 'https://www.google.com/s2/favicons?domain=iterm2.com&sz=64';

        // Create elements
        const tabEl = document.createElement('div');
        tabEl.className = 'tab';
        if (pinned) tabEl.classList.add('pinned');
        tabEl.setAttribute('data-pane-id', paneId);
        // Pinned tabs are locked to the front of the bar - never draggable.
        // Everything else gets HTML5 drag-reorder (localStorage only, see
        // moveTabTo / applyTabOrder / saveTabOrder).
        tabEl.draggable = !pinned;
        if (!pinned) {
            tabEl.addEventListener('dragstart', (e) => this.handleTabDragStart(e, paneId));
            tabEl.addEventListener('dragend', (e) => this.handleTabDragEnd(e));
        }
        tabEl.addEventListener('dragover', (e) => this.handleTabDragOver(e, paneId));
        tabEl.addEventListener('dragleave', (e) => this.handleTabDragLeave(e));
        tabEl.addEventListener('drop', (e) => this.handleTabDrop(e, paneId));
        
        const projectLabel = this.getProjectWorktreeLabel(cwd);
        let tooltipText = `Session: ${title} (${coder})`;
        if (projectLabel && projectLabel !== '—') {
            tooltipText += `\nProject: ${projectLabel}`;
        }
        if (cwd) {
            tooltipText += `\nPath: ${cwd}`;
        }
        tabEl.title = tooltipText;
        tabEl.innerHTML = `
            <button class="tab-pin" title="Pin session (Keep alive overnight)"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 12px; height: 12px;"><line x1="12" y1="17" x2="12" y2="22"></line><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"></path></svg></button>
            <img class="tab-favicon" src="${faviconUrl}" alt="${coder}">
            <span class="tab-title ${marked ? 'marked' : ''}">${title}</span>
            <button class="tab-close">×</button>
        `;
        
        const termContainer = document.createElement('div');
        termContainer.className = 'term-container';
        termContainer.id = `term-${paneId}`;
        
        let loaderEl = null;
        if (coder !== 'review' && coder !== 'kanban') {
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
        
        // Hide empty state landing page on tab creation
        this.hideEmptyState();
        
        tabEl.addEventListener('click', (e) => {
            const currentPaneId = tabEl.getAttribute('data-pane-id');
            if (e.target.closest('.tab-close')) {
                e.stopPropagation();
                this.closeTab(currentPaneId);
            } else if (e.target.closest('.tab-pin')) {
                e.stopPropagation();
                this.togglePinTab(currentPaneId);
            } else {
                this.switchTab(currentPaneId, { userInitiated: true });
            }
        });

        if (coder === 'review' || coder === 'kanban') {
            if (coder === 'review') {
                termContainer.classList.add('review-panel');
            } else if (coder === 'kanban') {
                termContainer.classList.add('kanban-panel');
            }
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
                isReview: coder === 'review',
                isKanban: coder === 'kanban',
                pinned: !!pinned,
                marked: !!marked
            };
            this.tabs.set(paneId, tabInfo);
            this.switchTab(paneId);
            return;
        }
        
        const isMobile = window.innerWidth <= 768;
        
        // Initialize xterm.js instance
        const term = new window.Terminal({
            cursorBlink: true,
            cursorStyle: 'bar',
            fontSize: isMobile ? 10 : 14,
            fontFamily: 'JetBrains Mono, monospace',
            scrollback: 10000, // avoid truncating the server's replay-on-reconnect buffer
            theme: {
                background: '#08080a',
                foreground: '#e4e3e9',
                cursor: document.documentElement.style.getPropertyValue('--accent') || '#7c6af7',
                cursorAccent: '#08080a',
                black: '#18181b',
                red: '#ef4444',
                green: '#22c55e',
                yellow: '#eab308',
                blue: '#3b82f6',
                magenta: '#a855f7',
                cyan: '#06b6d4',
                white: '#fafafa',
                brightBlack: '#71717a',
                brightRed: '#f87171',
                brightGreen: '#4ade80',
                brightYellow: '#facc15',
                brightBlue: '#60a5fa',
                brightMagenta: '#c084fc',
                brightCyan: '#22d3ee',
                brightWhite: '#ffffff'
            }
        });
        
        const fitAddon = new window.FitAddon.FitAddon();
        term.loadAddon(fitAddon);

        const searchAddon = new window.SearchAddon.SearchAddon();
        term.loadAddon(searchAddon);
        
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
                    this._agentClipboardCopy(text);
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
            // Support Ctrl+Shift+F inside xterm
            if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'f') {
                if (e.type === 'keydown') {
                    this.handleGlobalTabShortcuts(e);
                }
                return false;
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
                this.adjustInputHeight();
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
        // Scoped strictly to opencode tabs – all other coders pass through untouched.
        // We always send Ctrl+Alt+Y / Ctrl+Alt+E to the TUI regardless of alternate buffer detection,
        // as OpenCode is a full-screen TUI application and doesn't use standard terminal scrollback.
        termContainer.addEventListener('wheel', (e) => {
            if (tabInfo.coder !== 'opencode') return;

            const isUp = e.deltaY < 0;

            // Scale scroll amount from the wheel delta for natural-feeling speed
            // Math.abs(deltaY) is typically ~100 for a single notch; clamp to a sane range
            const lines = Math.max(1, Math.min(Math.round(Math.abs(e.deltaY) / 40), 8));

            e.preventDefault();
            e.stopPropagation();
            const seq = isUp ? '\x1b\x19' : '\x1b\x05';
            const payload = seq.repeat(lines);
            if (tabInfo.ws && !tabInfo.isDead) {
                tabInfo.ws.sendInput(payload);
            }
        }, { capture: true, passive: false });

        // Touch scrolling for OpenCode alt screen (TUI) on mobile viewports
        let termTouchStartY = 0;
        let termTouchRemainder = 0;
        termContainer.addEventListener('touchstart', (e) => {
            if (tabInfo.coder !== 'opencode') return;
            if (e.touches.length === 1) {
                termTouchStartY = e.touches[0].clientY;
                termTouchRemainder = 0;
            }
        }, { capture: true, passive: false });

        termContainer.addEventListener('touchmove', (e) => {
            if (tabInfo.coder !== 'opencode') return;
            if (e.touches.length === 1 && termTouchStartY !== null) {
                const currentY = e.touches[0].clientY;
                const rawDelta = currentY - termTouchStartY;
                const totalDelta = rawDelta + termTouchRemainder;
                const cellHeight = 16;
                
                const lines = Math.floor(Math.abs(totalDelta) / cellHeight);
                if (lines > 0) {
                    e.preventDefault();
                    e.stopPropagation();
                    
                    const isUp = totalDelta > 0; // swipe down -> scroll up
                    const seq = isUp ? '\x1b\x19' : '\x1b\x05';
                    const payload = seq.repeat(lines);
                    
                    if (tabInfo.ws && !tabInfo.isDead) {
                        tabInfo.ws.sendInput(payload);
                    }
                    
                    const consumed = lines * cellHeight * (totalDelta > 0 ? 1 : -1);
                    termTouchRemainder = totalDelta - consumed;
                    termTouchStartY = currentY;
                }
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
            searchAddon,
            tabEl,
            termContainer,
            directMode: false, // Hybrid focus model by default
            isDead: false,
            isAtBottom: true,
            isBtop: title === 'btop',
            pinned: !!pinned,
            marked: !!marked,
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
            (control) => { this.handleControlMessage(tabInfo, control); },
            () => {
                term.write('\r\n\x1b[31m[Connection lost]\x1b[0m\r\n');
                tabInfo.isDead = true;
                tabEl.classList.add('dead');
                this._showReconnectOverlay(tabInfo);
                this.updateDisconnectBanner();
                this.maybeAutoReconnect(tabInfo);
            },
            () => {
                try {
                    if (tabInfo === this.getActiveTab()) {
                        this.activateTabViewport(tabInfo, { scrollToBottom: true, autoReconnect: false });
                    } else {
                        tabInfo.fitAddon.fit();
                        this.sendResizeToBackend(tabInfo);
                    }

                    if (initialCmd) {
                        // Deliver startup command after terminal settles
                        setTimeout(() => {
                            if (initialCmd.length > 16 || initialCmd.includes('\n')) {
                                this.sendInput(tabInfo, '\x1b[200~' + initialCmd + '\x1b[201~\r');
                            } else {
                                this.sendInput(tabInfo, initialCmd + '\r');
                            }
                        }, 1000);
                    }
                } catch (e) {
                    console.error("[term] Fit/resize error on initial socket open:", e);
                }
            }
        );
        
        tabInfo.ws = ws;
        this.tabs.set(paneId, tabInfo);
        
        // Direct writing bridge — routes through tabInfo.ws so reconnect can swap the socket
        term.onData((data) => {
            if (tabInfo.directMode) {
                this.sendInput(tabInfo, data);
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
            if (tabInfo === this.getActiveTab()) {
                this.activateTabViewport(tabInfo, { scrollToBottom: true, autoReconnect: true });
            }
        }, 100);
    }
    
    switchTab(paneId, { userInitiated = false } = {}) {
        if (this.activePaneId === paneId) {
            const activeTab = this.getActiveTab();
            if (activeTab) {
                // Already on this tab - the user just clicked the active tab to
                // refocus. Don't scroll the terminal to bottom (loses their
                // scrollback position), but still run fit + reconnect so the
                // tab gets a chance to revive itself on explicit click.
                // Use scrollToBottom:false so a user mid-scrollback reading
                // old output doesn't get yanked to the bottom line.
                this.activateTabViewport(activeTab, { scrollToBottom: false, autoReconnect: true, force: userInitiated });
            }
            return;
        }
        
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
        if (newTab.coder === 'review' || newTab.coder === 'kanban') {
            this.inputBarContainer.classList.add('hidden');
        } else {
            this.inputBarContainer.classList.remove('hidden');
            this.updateDirectModeUI(newTab);
        }
        
        // Scroll tabs bar to active tab
        newTab.tabEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
        this.saveTabsState();
        
        // Update sidebar select state and active coder tab, but skip auto-reload since we coordinate it
        const prevCoder = this.app.sessionsManager.activeCoder;
        this.app.sessionsManager.switchCoder(newTab.coder, true);

        // BUG-1 fix: kanban and review are independent views — they were opened
        // with a snapshot of whatever workspace/cwd was active at the time, but
        // they don't track the user's actual terminal context. If the user has
        // since switched to a terminal tab in a different workspace/cwd and
        // then returns to kanban, blindly applying kanban's stale workspace/cwd
        // would clobber the sidebar and reload worktrees for the wrong project.
        // So skip the workspace/cwd sync for non-terminal coders entirely.
        if (newTab.coder === 'kanban' || newTab.coder === 'review') {
            this.app.sessionsManager.highlightActiveSession(newTab.sessionId);
            this.activateTabViewport(newTab, { scrollToBottom: true, autoReconnect: true, force: userInitiated });
            return;
        }

        // Sync project / workspace context from the tab using normalized paths
        const workspaceChanged = newTab.workspace && (normalizePath(this.app.sessionsManager.activeWorkspace) !== normalizePath(newTab.workspace));
        const coderChanged = prevCoder !== newTab.coder;
        const cwdChanged = newTab.cwd && (normalizePath(this.app.sessionsManager.activeCWD) !== normalizePath(newTab.cwd));

        if (workspaceChanged) {
            this.app.sessionsManager.workspaceSelect.value = newTab.workspace;
            this.app.sessionsManager.activeWorkspace = newTab.workspace;
            this.app.sessionsManager.activeCWD = newTab.cwd;
            this.app.sessionsManager.updateWorkspaceSelectWidth();
            
            this.app.sessionsManager.loadWorktrees(newTab.cwd).then(() => {
                this.app.sessionsManager.highlightActiveSession(newTab.sessionId);
                this.app.diffController.refreshDiff();
                if (this.app.markdownManager) {
                    this.app.markdownManager.refreshFiles({ force: false });
                }
            });
        } else if (coderChanged) {
            // Workspace is the same, but coder changed. We need to rebuild worktrees to load the sessions for the new coder!
            this.app.sessionsManager.activeCWD = newTab.cwd;
            this.app.sessionsManager.loadWorktrees(newTab.cwd).then(() => {
                this.app.sessionsManager.highlightActiveSession(newTab.sessionId);
                this.app.diffController.refreshDiff();
                if (this.app.markdownManager) {
                    this.app.markdownManager.refreshFiles({ force: false });
                }
            });
        } else if (cwdChanged) {
            // Workspace and coder are the same, only CWD changed.
            this.app.sessionsManager.activeCWD = newTab.cwd;
            this.app.sessionsManager.highlightActiveWorktree(newTab.cwd);
            this.app.sessionsManager.highlightActiveSession(newTab.sessionId);
            this.app.diffController.refreshDiff();
            if (this.app.markdownManager) {
                this.app.markdownManager.refreshFiles({ force: false });
            }
        } else {
            // Workspace, coder, and CWD are all the same, only session might have changed.
            this.app.sessionsManager.highlightActiveSession(newTab.sessionId);
        }
        
        this.activateTabViewport(newTab, { scrollToBottom: true, autoReconnect: true, force: userInitiated });
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
    
    syncBackendMark(paneId, marked) {
        fetch(`/api/terminals/${paneId}/mark`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ marked: marked })
        }).catch(err => console.error('[term] Failed to sync mark on backend:', err));
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

        // BUG-3 fix: notify the per-coder manager so it can tear down listeners
        // and overlays it added. Without this the kanban ESC listener, modal
        // overlays, and detail panel outlive the tab and can fire on the wrong pane.
        if (this.app.kanbanManager && tab.isKanban) {
            this.app.kanbanManager.cleanup();
        }
        if (this.app.reviewManager && tab.isReview) {
            this.app.reviewManager.cleanup?.();
        }

        this.tabs.delete(paneId);
        this.updateDisconnectBanner();
        
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
                this.showEmptyState();
                
                if (this.app.markdownManager) {
                    this.app.markdownManager.refreshFiles({ force: true });
                }
            }
        } else if (this.tabs.size === 0) {
            this.showEmptyState();
            if (this.app.markdownManager) {
                this.app.markdownManager.refreshFiles({ force: true });
            }
        }
    }

    showEmptyState() {
        const el = document.getElementById('empty-state');
        if (el) {
            el.classList.remove('hidden');
            const hostDisplay = document.getElementById('empty-state-hostname');
            if (hostDisplay) {
                hostDisplay.innerText = this.app.hostname || 'Localhost';
            }
        }
    }

    hideEmptyState() {
        const el = document.getElementById('empty-state');
        if (el) el.classList.add('hidden');
    }
    
    sendInput(tabInfo, payload) {
        if (!tabInfo || !tabInfo.ws || tabInfo.isDead) {
            this.app.showToast("Tab is disconnected — input not sent", { type: 'error' });
            if (tabInfo) this._showReconnectOverlay(tabInfo);
            return false;
        }
        const ok = tabInfo.ws.sendInput(payload);
        if (!ok) {
            this.app.showToast("Tab is disconnected — input not sent", { type: 'error' });
            this._showReconnectOverlay(tabInfo);
            return false;
        }
        return true;
    }

    sendStagedInput() {
        const activeTab = this.getActiveTab();
        if (!activeTab) return;
        
        const val = this.inputTextArea.value;
        if (!val) return;
        
        // Wrap in bracketed paste markers for large prompts or multiline text
        // to prevent TUI trickle-rendering / autocomplete lagging.
        let payload = val;
        if (val.length > 16 || val.includes('\n')) {
            payload = '\x1b[200~' + val + '\x1b[201~';
        }
        
        // No isDead pre-check: sendInput() toasts + shows the reconnect overlay on failure.
        const sent = this.sendInput(activeTab, payload + '\r');
        if (!sent) return;

        this.inputTextArea.value = '';
        this.lastInputValue = '';
        this.adjustInputHeight();
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
        if (!activeTab) return;
        // The backend PTY layer handles the Windows ConPTY quirk where a \r
        // bundled with preceding text fails to register as Enter — see pkg/pty.
        const sent = this.sendInput(activeTab, bytes);
        if (!sent) return;
        
        const isMobile = window.innerWidth <= 768;
        if (isMobile && !activeTab.directMode && this.inputTextArea) {
            this.inputTextArea.focus({ preventScroll: true });
        } else {
            this.focusActiveTerminal();
        }
        
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

        let msg = 'Connection lost';
        let showReconnect = true;

        if (tabInfo.exitCode !== undefined && tabInfo.exitCode !== null) {
            if (tabInfo.exitCode === -1) {
                msg = 'Session expired (PTY gone)';
                showReconnect = false;
            } else {
                msg = `process exited (code ${tabInfo.exitCode})`;
                showReconnect = false;
            }
        }

        overlay.innerHTML = `
            <div class="reconnect-box">
                <span class="reconnect-msg">${msg}</span>
                <div class="reconnect-buttons">
                    ${showReconnect ? '<button class="reconnect-btn">⟳ Reconnect</button>' : ''}
                    <button class="restart-btn">⚡ Restart</button>
                </div>
            </div>`;

        if (showReconnect) {
            overlay.querySelector('.reconnect-btn').addEventListener('click', () => {
                this.reconnectTab(tabInfo);
            });
        }
        overlay.querySelector('.restart-btn').addEventListener('click', () => {
            this.restartTab(tabInfo);
        });

        tabInfo.termContainer.appendChild(overlay);
    }

    handleControlMessage(tabInfo, control) {
        if (!control) return;
        if (control.type === 'pty-exited') {
            tabInfo.exitCode = control.code;
            tabInfo.isDead = true;
            tabInfo.tabEl.classList.add('dead');
            this._showReconnectOverlay(tabInfo);
        } else if (control.type === 'replay-complete') {
            if (localStorage.getItem('phi_replay_divider') === 'true') {
                tabInfo.term.write('\r\n\x1b[33m─── live ───\x1b[0m\r\n');
            }
        } else if (control.type === 'server-shutdown') {
            // Plan §3.1 / Phase 9: server announces restart/update/shutdown
            // and arms a client-side reload poller. The page reloads when
            // /api/version reports a different stamped version OR after 10s,
            // whichever comes first.
            this.handleServerShutdown(control.reason || 'shutdown');
        }
    }

    // handleServerShutdown is invoked when the WS control stream receives
    // a 0x05 frame. Polls /api/version every 1s; reloads the page when the
    // server is back (different commit or after a generous timeout).
    handleServerShutdown(reason) {
        if (this._reloadArmed) return;
        this._reloadArmed = true;

        // Show a one-time toast so the user knows what's happening.
        if (this.app && this.app.showToast) {
            this.app.showToast(
                `phi is ${reason}… reloading when ready.`,
                { type: 'info', durationMs: 8000 }
            );
        }

        const beforeCommit = (this.app && this.app.versionInfo && this.app.versionInfo.commit) || '';
        const startedAt = Date.now();
        const maxWaitMs = 10_000;

        const poll = async () => {
            // Bail out once we've waited long enough regardless.
            if (Date.now() - startedAt > maxWaitMs) {
                window.location.reload();
                return;
            }
            try {
                const res = await fetch('/api/version', { cache: 'no-store' });
                if (res.ok) {
                    const data = await res.json();
                    // Same commit + same source = same process (still
                    // tearing down). Different commit or different
                    // build_source (e.g. release->source for a swap)
                    // means the new server is up.
                    if (data && data.commit && data.commit !== beforeCommit) {
                        window.location.reload();
                        return;
                    }
                }
            } catch (_) {
                // network blip while server is bouncing; keep polling
            }
            setTimeout(poll, 1000);
        };
        setTimeout(poll, 1000);
    }

    reconnectTab(tabInfo, { auto = false } = {}) {
        if (tabInfo.reconnectInFlight) return;
        tabInfo.reconnectInFlight = true;
        tabInfo.exitCode = null;

        const overlay = tabInfo.termContainer.querySelector('.reconnect-overlay');
        const msgEl = overlay?.querySelector('.reconnect-msg');
        const btnEl = overlay?.querySelector('.reconnect-btn');
        const restartBtn = overlay?.querySelector('.restart-btn');

        if (msgEl) msgEl.innerText = auto ? 'reconnecting…' : 'connecting…';
        if (btnEl) btnEl.disabled = true;
        if (restartBtn) restartBtn.disabled = true;

        if (tabInfo.ws) try { tabInfo.ws.close(); } catch(e) {}

        let opened = false;
        try {
            const newWs = new PTYWebSocket(
                tabInfo.paneId,
                (data) => { this.writeToTerminal(tabInfo, data); },
                (control) => { this.handleControlMessage(tabInfo, control); },
                () => {
                    tabInfo.reconnectInFlight = false;
                    if (!opened) {
                        if (msgEl) msgEl.innerText = 'Session expired (PTY gone)';
                        if (btnEl) { btnEl.disabled = false; btnEl.innerText = '⟳ Retry'; }
                        if (restartBtn) restartBtn.disabled = false;
                        this.updateDisconnectBanner();
                        this.maybeAutoReconnect(tabInfo);
                    } else {
                        tabInfo.isDead = true;
                        tabInfo.tabEl.classList.add('dead');
                        this._showReconnectOverlay(tabInfo);
                        this.updateDisconnectBanner();
                        this.maybeAutoReconnect(tabInfo);
                    }
                },
                () => {
                    opened = true;
                    tabInfo.reconnectAttempts = 0;
                    tabInfo.reconnectInFlight = false;
                    tabInfo.isDead = false;
                    tabInfo.tabEl.classList.remove('dead');
                    if (overlay) overlay.remove();
                    tabInfo.term.write('\r\n\x1b[32m[Reconnected]\x1b[0m\r\n');
                    this.updateDisconnectBanner();
                    setTimeout(() => {
                        try {
                            if (tabInfo === this.getActiveTab()) {
                                tabInfo.term.refresh(0, tabInfo.term.rows - 1);
                            }
                        } catch (e) {
                            console.error("[term] Fit/refresh error on reconnect:", e);
                        }
                        this.activateTabViewport(tabInfo, { scrollToBottom: true, autoReconnect: false });
                    }, 100);
                }
            );
            tabInfo.ws = newWs;
        } catch (e) {
            tabInfo.reconnectInFlight = false;
            if (msgEl) msgEl.innerText = `failed: ${e.message}`;
            if (btnEl) { btnEl.disabled = false; btnEl.innerText = '⟳ Retry'; }
            if (restartBtn) restartBtn.disabled = false;
            console.error("[term] PTYWebSocket instantiation threw:", e);
        }
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
                session_id: tabInfo.sessionId || '',
                title: tabInfo.title || '',
                workspace: tabInfo.workspace || ''
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
                (control) => { this.handleControlMessage(tabInfo, control); },
                () => {
                    if (!opened) {
                        if (msgEl) msgEl.innerText = 'Session expired (PTY gone)';
                        if (reconnectBtn) reconnectBtn.disabled = false;
                        if (restartBtn) restartBtn.disabled = false;
                        this.updateDisconnectBanner();
                    } else {
                        tabInfo.isDead = true;
                        tabInfo.tabEl.classList.add('dead');
                        this._showReconnectOverlay(tabInfo);
                        this.updateDisconnectBanner();
                    }
                },
                () => {
                    opened = true;
                    tabInfo.isDead = false;
                    tabInfo.tabEl.classList.remove('dead');
                    if (overlay) overlay.remove();
                    this.updateDisconnectBanner();
                    
                    // Trigger terminal fit & backend resize to synchronise viewport
                    setTimeout(() => {
                        this.activateTabViewport(tabInfo, { scrollToBottom: true, autoReconnect: false });
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

    updateDisconnectBanner() {
        const banner = document.getElementById('disconnect-banner');
        if (!banner) return;

        const deadTabs = [];
        for (const tabInfo of this.tabs.values()) {
            if (tabInfo.isDead && (tabInfo.exitCode === undefined || tabInfo.exitCode === null) && tabInfo.coder !== 'review' && tabInfo.coder !== 'kanban') {
                deadTabs.push(tabInfo);
            }
        }

        const currentCount = deadTabs.length;
        if (currentCount === 0) {
            banner.classList.add('hidden');
            this._bannerDismissed = false;
            this._dismissedCount = 0;
            return;
        }

        if (this._bannerDismissed && currentCount <= this._dismissedCount) {
            banner.classList.add('hidden');
            return;
        }

        this._bannerDismissed = false;
        banner.classList.remove('hidden');
        banner.innerHTML = `
            <span>${currentCount} tab${currentCount > 1 ? 's' : ''} disconnected</span>
            <div style="display: flex; gap: 8px;">
                <button class="disconnect-banner-btn reconnect-all-banner-btn">Reconnect all</button>
                <button class="disconnect-banner-btn dismiss-banner-btn" style="background:transparent;border-color:rgba(255,255,255,0.2);">Dismiss</button>
            </div>
        `;

        banner.querySelector('.reconnect-all-banner-btn').addEventListener('click', () => {
            this.reconnectAllDead();
        });
        banner.querySelector('.dismiss-banner-btn').addEventListener('click', () => {
            this._bannerDismissed = true;
            this._dismissedCount = currentCount;
            banner.classList.add('hidden');
        });
    }

    reconnectAllDead() {
        for (const tabInfo of this.tabs.values()) {
            if (tabInfo.isDead && (tabInfo.exitCode === undefined || tabInfo.exitCode === null) && tabInfo.coder !== 'review' && tabInfo.coder !== 'kanban') {
                this.reconnectTab(tabInfo, { auto: false });
            }
        }
        const activeTab = this.getActiveTab();
        if (activeTab) {
            this.activateTabViewport(activeTab, { scrollToBottom: true, autoReconnect: false });
        }
        this.updateDisconnectBanner();
    }

    maybeAutoReconnect(tabInfo) {
        const autoReconnect = this.app.config && this.app.config.auto_reconnect;
        if (autoReconnect !== 'visible') return false;

        if (document.visibilityState !== 'visible') return false;
        if (tabInfo.paneId !== this.activePaneId) return false;
        if (tabInfo.exitCode !== undefined && tabInfo.exitCode !== null) return false;

        if (!tabInfo.reconnectAttempts) tabInfo.reconnectAttempts = 0;
        if (tabInfo.reconnectAttempts >= 5) {
            tabInfo.reconnectAttempts = 0;
            return false;
        }

        tabInfo.reconnectAttempts++;
        const delay = Math.min(30000, Math.pow(2, tabInfo.reconnectAttempts - 1) * 1000);
        
        console.log(`[term] Auto-reconnecting pane ${tabInfo.paneId} (attempt ${tabInfo.reconnectAttempts}) in ${delay}ms...`);
        
        const overlay = tabInfo.termContainer.querySelector('.reconnect-overlay');
        const msgEl = overlay?.querySelector('.reconnect-msg');
        if (msgEl) msgEl.innerText = `auto-reconnecting (attempt ${tabInfo.reconnectAttempts}/5)...`;

        setTimeout(() => {
            if (tabInfo.isDead && tabInfo.paneId === this.activePaneId && (tabInfo.exitCode === undefined || tabInfo.exitCode === null)) {
                this.reconnectTab(tabInfo, { auto: true });
            }
        }, delay);

        return true;
    }

    toggleFindBar(tabInfo) {
        const existing = tabInfo.termContainer.querySelector('.find-bar');
        if (existing) {
            existing.remove();
            if (tabInfo.searchAddon) {
                tabInfo.searchAddon.clearDecorations();
            }
            tabInfo.term.focus();
            return;
        }

        const bar = document.createElement('div');
        bar.className = 'find-bar';
        bar.innerHTML = `
            <input type="text" class="find-input" placeholder="Find in terminal..." />
            <button class="find-btn find-prev">▲</button>
            <button class="find-btn find-next">▼</button>
            <button class="find-btn find-close">✕</button>
        `;

        const input = bar.querySelector('.find-input');
        const prevBtn = bar.querySelector('.find-prev');
        const nextBtn = bar.querySelector('.find-next');
        const closeBtn = bar.querySelector('.find-close');

        const doSearch = (direction) => {
            const val = input.value;
            if (!val) {
                if (tabInfo.searchAddon) tabInfo.searchAddon.clearDecorations();
                return;
            }
            if (tabInfo.searchAddon) {
                if (direction === 'prev') {
                    tabInfo.searchAddon.findPrevious(val, { decorations: { matchBackground: 'rgba(255,255,0,0.3)', activeMatchBackground: 'rgba(255,165,0,0.5)' } });
                } else {
                    tabInfo.searchAddon.findNext(val, { decorations: { matchBackground: 'rgba(255,255,0,0.3)', activeMatchBackground: 'rgba(255,165,0,0.5)' } });
                }
            }
        };

        input.addEventListener('input', () => {
            doSearch('next');
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                doSearch(e.shiftKey ? 'prev' : 'next');
            } else if (e.key === 'Escape') {
                e.preventDefault();
                bar.remove();
                if (tabInfo.searchAddon) tabInfo.searchAddon.clearDecorations();
                tabInfo.term.focus();
            }
        });

        prevBtn.addEventListener('click', () => doSearch('prev'));
        nextBtn.addEventListener('click', () => doSearch('next'));
        closeBtn.addEventListener('click', () => {
            bar.remove();
            if (tabInfo.searchAddon) tabInfo.searchAddon.clearDecorations();
            tabInfo.term.focus();
        });

        tabInfo.termContainer.appendChild(bar);
        input.focus({ preventScroll: true });
    }

    handleGlobalTabShortcuts(e) {
        if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'f') {
            const activeTab = this.getActiveTab();
            if (activeTab && activeTab.term) {
                e.preventDefault();
                this.toggleFindBar(activeTab);
            }
            return;
        }

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
                this.switchTab(targetPaneId, { userInitiated: true });
            }
            return;
        }

        if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.key === 'Enter') {
            const activeTab = this.getActiveTab();
            if (activeTab) {
                e.preventDefault();
                this.sendInput(activeTab, '\x1b[A');
                setTimeout(() => {
                    this.sendInput(activeTab, '\r');
                }, 30);
            }
        }

        // Ctrl+P: capture it so the browser's print dialog never hijacks the key,
        // and forward it (\x10) to the active terminal — opencode and other TUIs
        // use Ctrl+P. Runs at document bubble phase, so if an earlier handler
        // already dealt with it (e.g. the empty staged-input box calls
        // preventDefault and sends \x10 itself, or xterm consumed it while the
        // terminal was focused) we bail via defaultPrevented to avoid double-send.
        if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'p') {
            if (e.defaultPrevented) return;
            const activeTab = this.getActiveTab();
            if (activeTab && activeTab.coder !== 'review' && activeTab.coder !== 'kanban') {
                e.preventDefault();
                this.sendInput(activeTab, '\x10');
                this._spamScrollToBottom(activeTab);
            }
            return;
        }
    }

    adjustInputHeight() {
        if (!this.inputTextArea) return;
        this.inputTextArea.style.height = 'auto';
        let newHeight = this.inputTextArea.scrollHeight;
        // If empty, prevent the placeholder wrap from making the textarea fat
        if (this.inputTextArea.value.trim() === '') {
            newHeight = window.innerWidth <= 768 ? 36 : 40;
            if (window.innerWidth <= 768) {
                this.inputTextArea.placeholder = "Type a prompt...";
            }
        }
        this.inputTextArea.style.height = newHeight + 'px';
    }

    _spamScroll(tabInfo, isAtBottom, scrollY = null) {
        if (!tabInfo || tabInfo.isDead) return;
        
        clearInterval(tabInfo.spamInterval);
        clearTimeout(tabInfo.stopSpamTimeout);
        
        tabInfo.isSpammingBottom = isAtBottom;
        tabInfo.spamScrollY = scrollY;
        
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
            tabInfo.isSpammingBottom = undefined;
            tabInfo.spamScrollY = undefined;
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

    // Synchronous execCommand('copy') via a hidden textarea. Returns whether it
    // succeeded. Works in insecure contexts (plain-HTTP LAN access) where the
    // async Clipboard API is unavailable, as long as it runs within a user
    // gesture. Does not show any toast.
    _execCommandCopy(text) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.top = '0';
        ta.style.left = '0';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus({ preventScroll: true });
        ta.select();
        let ok = false;
        try {
            ok = document.execCommand('copy');
        } catch (e) {
            ok = false;
        }
        document.body.removeChild(ta);
        return ok;
    }

    // Copy text the agent emitted via OSC 52. phi is commonly served over plain
    // HTTP on a LAN address, where navigator.clipboard is undefined and calling
    // writeText throws synchronously — the previous inline handler let that
    // exception fall into the OSC decode catch, so opencode reported "copied"
    // while nothing reached the clipboard. Prefer the async Clipboard API when
    // it truly exists in a secure context, otherwise fall back to execCommand,
    // and if every automated attempt fails, surface a toast with a manual copy
    // button that runs inside the click's user-gesture. Returns a promise.
    _agentClipboardCopy(text) {
        const okToast = () => this.app.showToast(
            `Agent copied ${text.length} characters to clipboard`,
            { type: 'info', title: 'Clipboard Sync' }
        );
        const manualToast = () => this.app.showToast(`Agent copied ${text.length} characters`, {
            type: 'info',
            title: 'Clipboard Sync',
            duration: 15000,
            action: {
                text: 'Copy to Clipboard',
                callback: () => {
                    if (this._execCommandCopy(text)) {
                        this.app.showToast("Copied to clipboard!", { type: 'info', title: 'Clipboard Sync' });
                    } else {
                        this.app.showToast("Failed to copy. Please copy manually.", { type: 'error', title: 'Clipboard Sync' });
                    }
                }
            }
        });

        if (navigator.clipboard && window.isSecureContext && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(text)
                .then(okToast)
                .catch(() => { if (this._execCommandCopy(text)) okToast(); else manualToast(); });
        }
        // Insecure context (e.g. http://host:port over LAN): no Clipboard API.
        if (this._execCommandCopy(text)) okToast(); else manualToast();
        return Promise.resolve();
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
            const isMobile = window.innerWidth <= 768;
            const size = isMobile ? 10 : 14;
            if (activeTab.term.options.fontSize !== size) {
                activeTab.term.options.fontSize = size;
            }

            // Capture scroll state PRE-FIT
            const buffer = activeTab.term.buffer.active;
            let isAtBottom;
            let scrollY;
            
            // If we are resizing continuously, cache these stable coordinates on the tab
            if (this.isResizing) {
                isAtBottom = activeTab.isAtBottom !== undefined ? activeTab.isAtBottom : (buffer.viewportY >= buffer.baseY - 1);
                scrollY = activeTab.lastScrollY !== undefined ? activeTab.lastScrollY : buffer.viewportY;
                activeTab.isAtBottom = isAtBottom;
                activeTab.lastScrollY = scrollY;
            } else if (activeTab.spamInterval && activeTab.isSpammingBottom !== undefined) {
                // If a spam scroll is already trying to force the scroll position, respect its intended target 
                // instead of capturing a mid-flight coordinate.
                isAtBottom = activeTab.isSpammingBottom;
                scrollY = activeTab.spamScrollY;
            } else {
                isAtBottom = (buffer.viewportY >= buffer.baseY - 1);
                scrollY = buffer.viewportY;
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

    activateTabViewport(tabInfo, { scrollToBottom = true, autoReconnect = true, force = false } = {}) {
        if (!tabInfo) return;

        setTimeout(() => {
            if (tabInfo === this.getActiveTab()) {
                this.fitActiveTerminal();
            }
        }, 50);

        if (scrollToBottom && tabInfo.term && !tabInfo.isDead) {
            this._spamScrollToBottom(tabInfo);
        }

        // force=true bypasses the passive auto_reconnect gate for explicit user actions.
        const configAutoReconnect = this.app.config && this.app.config.auto_reconnect;
        if (autoReconnect && (force || configAutoReconnect === 'visible') && tabInfo.isDead && tabInfo.coder !== 'review' && tabInfo.coder !== 'kanban' && !tabInfo.reconnectInFlight) {
            if (tabInfo.exitCode === undefined || tabInfo.exitCode === null) {
                this.reconnectTab(tabInfo, { auto: true });
            }
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
            let left = btnRect.left - containerRect.left;
            const dropupWidth = window.innerWidth <= 768 ? Math.min(280, window.innerWidth - 24) : 320;
            left = Math.max(12, Math.min(left, containerRect.width - dropupWidth - 12));
            dropup.style.left = `${left}px`;
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
        
        const isMobile = window.innerWidth <= 768;

        // 1. Render Static Coder Presets / Slash Menu
        if (hasCoderPresets) {
            if (isMobile) {
                // Separate slash commands from utility shortcuts
                const slashPresets = coderPresetInfo.presets.filter(p => p.value.startsWith('/'));
                const utilityPresets = coderPresetInfo.presets.filter(p => !p.value.startsWith('/'));

                // Render single Slash trigger button if slash commands exist
                if (slashPresets.length > 0) {
                    const slashBtn = document.createElement('button');
                    slashBtn.className = 'preset-btn slash-trigger-btn';
                    slashBtn.innerText = '/ ▾';
                    slashBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this._toggleDropup('slash-presets-dropup', slashBtn, () => this.renderSlashDropup(slashPresets));
                    });
                    this.presetsContainer.appendChild(slashBtn);
                }

                // Render other horizontal utility presets (like ctrl+c, esc, y)
                utilityPresets.forEach(p => {
                    const btn = document.createElement('button');
                    btn.className = 'preset-btn';
                    btn.innerText = p.name;
                    btn.addEventListener('click', () => {
                        this.sendRawInput(p.value);
                    });
                    this.presetsContainer.appendChild(btn);
                });
            } else {
                // Desktop: Render everything horizontally as before
                coderPresetInfo.presets.forEach(p => {
                    const btn = document.createElement('button');
                    btn.className = 'preset-btn';
                    btn.innerText = p.name;
                    btn.addEventListener('click', () => {
                        const activeTab = this.getActiveTab();
                        if (activeTab && (activeTab.coder === 'opencode' || activeTab.coder === 'pi') && p.value.startsWith('/') && p.value.endsWith('\r')) {
                            const cmd = p.value.slice(0, -1);
                            this.sendRawInput('\x1b[200~' + cmd + '\x1b[201~');
                            setTimeout(() => {
                                this.sendRawInput('\r');
                            }, 200);
                        } else {
                            this.sendRawInput(p.value);
                        }
                    });
                    this.presetsContainer.appendChild(btn);
                });
            }
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
        
        if (activeTab && activeTab.coder === 'agy') {
            modelsTriggerBtn.disabled = true;
            modelsTriggerBtn.classList.add('disabled');
            modelsTriggerBtn.title = 'Model selection not supported for Antigravity';
        } else {
            modelsTriggerBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._toggleDropup('model-presets-dropup', modelsTriggerBtn, () => this.renderModelDropup());
            });
        }
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
        const slashDropup = document.getElementById('slash-presets-dropup');
        if (slashDropup && !slashDropup.classList.contains('hidden')) {
            const slashPresets = coderPresetInfo ? coderPresetInfo.presets.filter(p => p.value.startsWith('/')) : [];
            this.renderSlashDropup(slashPresets);
        }

        // 5. Render mobile virtual navigation keys (arrows) to compensate for touch keyboard limits
        if (isMobile) {
            const divider = document.createElement('div');
            divider.className = 'presets-divider';
            this.presetsContainer.appendChild(divider);

            const mobileNavs = [
                { name: '▲', value: '\u001b[A' },
                { name: '▼', value: '\u001b[B' },
                { name: '◀', value: '\u001b[D' },
                { name: '▶', value: '\u001b[C' }
            ];

            mobileNavs.forEach(nav => {
                const btn = document.createElement('button');
                btn.className = 'preset-btn mobile-nav-btn';
                btn.innerText = nav.name;
                btn.addEventListener('click', () => {
                    this.sendRawInput(nav.value);
                });
                this.presetsContainer.appendChild(btn);
            });
        }
    }

    renderSlashDropup(slashPresets) {
        const dropup = document.getElementById('slash-presets-dropup');
        if (!dropup) return;
        dropup.innerHTML = '';

        const header = document.createElement('div');
        header.className = 'dropup-header';
        header.innerText = 'Slash Commands';
        dropup.appendChild(header);

        if (slashPresets.length === 0) {
            const row = document.createElement('div');
            row.className = 'dropup-row';
            row.style.color = 'var(--text-muted)';
            row.style.padding = '8px 12px';
            row.style.fontSize = '12px';
            row.innerText = 'No commands';
            dropup.appendChild(row);
            return;
        }

        slashPresets.forEach(p => {
            const row = document.createElement('div');
            row.className = 'dropup-row';

            const btn = document.createElement('button');
            btn.className = 'dropup-model-btn';
            btn.innerText = p.name;
            btn.addEventListener('click', () => {
                const activeTab = this.getActiveTab();
                if (activeTab && (activeTab.coder === 'opencode' || activeTab.coder === 'pi') && p.value.startsWith('/') && p.value.endsWith('\r')) {
                    const cmd = p.value.slice(0, -1);
                    this.sendRawInput('\x1b[200~' + cmd + '\x1b[201~');
                    setTimeout(() => {
                        this.sendRawInput('\r');
                    }, 200);
                } else {
                    this.sendRawInput(p.value);
                }
                dropup.classList.add('hidden');
            });
            row.appendChild(btn);
            dropup.appendChild(row);
        });
    }

    renderHostnameTabsDropdown() {
        const dropdown = document.getElementById('hostname-tabs-dropdown');
        if (!dropdown) return;
        dropdown.innerHTML = '';

        const header = document.createElement('div');
        header.className = 'dropup-header';
        header.style.borderBottom = '1px solid var(--bg-border)';
        header.style.padding = '6px 12px';
        header.style.color = 'var(--accent)';
        header.innerText = 'Active Sessions';
        dropdown.appendChild(header);

        if (this.tabs.size === 0) {
            const emptyItem = document.createElement('div');
            emptyItem.className = 'hostname-dropdown-item';
            emptyItem.style.color = 'var(--text-muted)';
            emptyItem.innerText = 'No active tabs';
            dropdown.appendChild(emptyItem);
            return;
        }

        for (const [paneId, tabInfo] of this.tabs.entries()) {
            const row = document.createElement('div');
            row.className = 'hostname-dropdown-row';
            if (paneId === this.activePaneId) {
                row.classList.add('active');
            }

            // Click target to switch tab
            const selectBtn = document.createElement('button');
            selectBtn.className = 'hostname-dropdown-select-btn';

            // Coder favicon (icon-only — the coder prefix text was redundant
            // since the favicon already identifies the coder)
            const faviconImg = document.createElement('img');
            faviconImg.className = 'hostname-dropdown-favicon';
            faviconImg.src = CODER_FAVICONS[tabInfo.coder] || CODER_FAVICONS.bash;
            faviconImg.alt = tabInfo.coder;

            const titleSpan = document.createElement('span');
            titleSpan.className = 'hostname-dropdown-title';
            if (tabInfo.marked) {
                titleSpan.classList.add('marked');
            }
            titleSpan.innerText = tabInfo.title || 'Session';

            const metaSpan = document.createElement('span');
            metaSpan.className = 'hostname-dropdown-meta';
            // Show project/worktree path instead of redundant status
            metaSpan.innerText = this.getProjectWorktreeLabel(tabInfo.cwd);
            metaSpan.style.color = 'var(--text-muted)';
            metaSpan.style.fontSize = '10px';

            selectBtn.appendChild(faviconImg);
            selectBtn.appendChild(titleSpan);
            selectBtn.appendChild(metaSpan);
            selectBtn.addEventListener('click', () => {
                this.switchTab(paneId, { userInitiated: true });
                dropdown.classList.add('hidden');
            });
            row.appendChild(selectBtn);

            // Marker button (toggles glow on session name)
            const markerBtn = document.createElement('button');
            markerBtn.className = 'hostname-dropdown-marker-btn';
            if (tabInfo.marked) {
                markerBtn.classList.add('marked');
            }
            markerBtn.innerHTML = '◆';
            markerBtn.title = 'Mark session (highlights in list)';
            markerBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                tabInfo.marked = !tabInfo.marked;
                this.syncBackendMark(paneId, tabInfo.marked);
                this.renderHostnameTabsDropdown(); // refresh to show updated state
            });
            row.appendChild(markerBtn);

            // Pin button
            const pinBtn = document.createElement('button');
            pinBtn.className = 'hostname-dropdown-pin-btn';
            if (tabInfo.pinned) {
                pinBtn.classList.add('pinned');
            }
            pinBtn.innerHTML = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 12px; height: 12px;"><line x1="12" y1="17" x2="12" y2="22"></line><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"></path></svg>`;
            pinBtn.title = 'Pin session (Keep alive overnight)';
            pinBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.togglePinTab(paneId);
                this.renderHostnameTabsDropdown(); // refresh dropdown layout
            });
            row.appendChild(pinBtn);

            // Close button
            const closeBtn = document.createElement('button');
            closeBtn.className = 'hostname-dropdown-close-btn';
            closeBtn.innerHTML = '×';
            closeBtn.title = 'Close session';
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (confirm(`Close session: ${tabInfo.title || 'Session'}?`)) {
                    this.closeTab(paneId);
                    this.renderHostnameTabsDropdown(); // refresh dropdown layout
                }
            });
            row.appendChild(closeBtn);

            dropdown.appendChild(row);
        }
    }

    getProjectWorktreeLabel(cwd) {
        return projectWorktreeLabel(cwd);
    }

    async addModelPreset(backend) {
        const values = await this.app.openConfigEditor({
            title: 'Add Model Preset',
            subtitle: `Saved under ${backend}. Use the exact model identifier your backend expects.`,
            fields: [
                { id: 'model', label: 'Model identifier', placeholder: 'provider/model-name' }
            ],
            submitLabel: 'Add Model'
        });
        if (!values) return;

        try {
            const res = await fetch('/api/config/models', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: values.model, coder: backend })
            });
            if (!res.ok) throw new Error(await res.text() || 'Failed to add model preset');
            await this.app.sessionsManager.loadConfig();
            this.renderModelDropup();
            this.app.showToast(`Added model preset "${values.model}"`, { type: 'info', title: 'Models' });
        } catch (err) {
            console.error("Failed to add model preset:", err);
            this.app.showToast(err.message, { type: 'error', title: 'Models' });
        }
    }

    async editModelPreset(backend, model) {
        const values = await this.app.openConfigEditor({
            title: 'Edit Model Preset',
            subtitle: `Update the saved model identifier for ${backend}.`,
            fields: [
                { id: 'model', label: 'Model identifier', value: model, placeholder: 'provider/model-name' }
            ],
            submitLabel: 'Save Model'
        });
        if (!values || values.model === model) return;

        try {
            const res = await fetch('/api/config/models', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ old_model: model, model: values.model, coder: backend })
            });
            if (!res.ok) throw new Error(await res.text() || 'Failed to edit model preset');
            await this.app.sessionsManager.loadConfig();
            this.renderModelDropup();
            this.app.showToast(`Updated model preset "${values.model}"`, { type: 'info', title: 'Models' });
        } catch (err) {
            console.error("Failed to edit model preset:", err);
            this.app.showToast(err.message, { type: 'error', title: 'Models' });
        }
    }

    async addQuickCommand() {
        const values = await this.app.openConfigEditor({
            title: 'Add Quick Command',
            subtitle: 'Quick commands run in the active terminal. Use {} as a placeholder for selected input text.',
            fields: [
                { id: 'name', label: 'Label', placeholder: 'tests', monospace: false },
                { id: 'command', label: 'Command', placeholder: 'npm test', multiline: true }
            ],
            submitLabel: 'Add Command'
        });
        if (!values) return;

        try {
            const res = await fetch('/api/config/quick-commands', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: values.name, command: values.command })
            });
            if (!res.ok) throw new Error(await res.text() || 'Failed to add quick command');
            await this.app.sessionsManager.loadConfig();
            this.renderQuickCmdsDropup();
            this.app.showToast(`Added quick command "${values.name}"`, { type: 'info', title: 'Commands' });
        } catch (err) {
            console.error("Failed to add quick command:", err);
            this.app.showToast(err.message, { type: 'error', title: 'Commands' });
        }
    }

    async editQuickCommand(cmd) {
        const values = await this.app.openConfigEditor({
            title: 'Edit Quick Command',
            subtitle: 'Rename the action or change the text sent to the active terminal.',
            fields: [
                { id: 'name', label: 'Label', value: cmd.name, monospace: false },
                { id: 'command', label: 'Command', value: cmd.command, multiline: true }
            ],
            submitLabel: 'Save Command'
        });
        if (!values || (values.name === cmd.name && values.command === cmd.command)) return;

        try {
            const res = await fetch('/api/config/quick-commands', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ old_name: cmd.name, name: values.name, command: values.command })
            });
            if (!res.ok) throw new Error(await res.text() || 'Failed to edit quick command');
            await this.app.sessionsManager.loadConfig();
            this.renderQuickCmdsDropup();
            this.app.showToast(`Updated quick command "${values.name}"`, { type: 'info', title: 'Commands' });
        } catch (err) {
            console.error("Failed to edit quick command:", err);
            this.app.showToast(err.message, { type: 'error', title: 'Commands' });
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
                    this.sendRawInput('/models');
                    setTimeout(() => {
                        this.sendRawInput('\r');
                        setTimeout(() => {
                            this.sendRawInput(model);
                            setTimeout(() => {
                                this.sendRawInput('\r');
                            }, 350);
                        }, 350);
                    }, 350);
                } else if (backend === 'pi') {
                    this.sendRawInput(`\x1b[200~/model ${model}\x1b[201~`);
                    setTimeout(() => {
                        this.sendRawInput('\r');
                    }, 200);
                } else {
                    this.sendRawInput(`/model ${model}\r`);
                }
                dropup.classList.add('hidden');
            });
            row.appendChild(btn);
            
            const actionsContainer = document.createElement('div');
            actionsContainer.className = 'dropup-row-actions';

            const editBtn = document.createElement('button');
            editBtn.className = 'dropup-action-btn dropup-edit-btn';
            editBtn.innerHTML = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 12px; height: 12px;"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>`;
            editBtn.title = `Edit model preset ${model}`;
            editBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                await this.editModelPreset(backend, model);
            });
            actionsContainer.appendChild(editBtn);

            const delBtn = document.createElement('button');
            delBtn.className = 'dropup-action-btn dropup-del-btn';
            delBtn.innerHTML = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 12px; height: 12px;"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>`;
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
            actionsContainer.appendChild(delBtn);
            row.appendChild(actionsContainer);
            dropup.appendChild(row);
        });
        
        // 3. Add Preset Action Row
        const addRow = document.createElement('div');
        addRow.className = 'dropup-add-row';
        
        const addBtn = document.createElement('button');
        addBtn.className = 'dropup-add-btn';
        addBtn.innerText = '+ Add Model Preset...';
        addBtn.addEventListener('click', async () => {
            await this.addModelPreset(backend);
        });
        addRow.appendChild(addBtn);
        dropup.appendChild(addRow);

        // 4. Config Copy/Paste Footer
        this._appendConfigFooter(dropup, 'models');
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
                if (!activeTab) return;
                const prefix = this.inputTextArea.value.trim();
                const combined = prefix && cmd.command.includes('{}')
                    ? cmd.command.replace('{}', prefix)
                    : prefix ? `${prefix} ${cmd.command}` : cmd.command;
                let payload = combined;
                if (combined.length > 16 || combined.includes('\n')) {
                    payload = '\x1b[200~' + combined + '\x1b[201~';
                }
                this.sendInput(activeTab, payload + '\r');
                this.inputTextArea.value = '';
                this.lastInputValue = '';
                this.adjustInputHeight();
                this.inputTextArea.focus({ preventScroll: true });
                this._spamScrollToBottom(activeTab);
                dropup.classList.add('hidden');
            });
            row.appendChild(btn);

            const actionsContainer = document.createElement('div');
            actionsContainer.className = 'dropup-row-actions';

            const editBtn = document.createElement('button');
            editBtn.className = 'dropup-action-btn dropup-edit-btn';
            editBtn.innerHTML = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 12px; height: 12px;"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>`;
            editBtn.title = `Edit quick command "${cmd.name}"`;
            editBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                await this.editQuickCommand(cmd);
            });
            actionsContainer.appendChild(editBtn);

            const delBtn = document.createElement('button');
            delBtn.className = 'dropup-action-btn dropup-del-btn';
            delBtn.innerHTML = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 12px; height: 12px;"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>`;
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
            actionsContainer.appendChild(delBtn);
            row.appendChild(actionsContainer);
            dropup.appendChild(row);
        });

        const addRow = document.createElement('div');
        addRow.className = 'dropup-add-row';

        const addBtn = document.createElement('button');
        addBtn.className = 'dropup-add-btn';
        addBtn.innerText = '+ Add Command...';
        addBtn.addEventListener('click', async () => {
            await this.addQuickCommand();
        });
        addRow.appendChild(addBtn);
        dropup.appendChild(addRow);

        // Config Copy/Paste Footer
        this._appendConfigFooter(dropup, 'cmds');
    }

    _appendConfigFooter(dropup, mode = 'models') {
        const footer = document.createElement('div');
        footer.className = 'dropup-config-footer';

        const copyBtn = document.createElement('button');
        copyBtn.className = 'dropup-config-btn';
        copyBtn.title = mode === 'cmds' ? 'Copy commands config to clipboard' : 'Copy models config to clipboard';
        copyBtn.innerHTML = '↑ Copy config';
        copyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (mode === 'cmds') {
                // Right-side cmds = quick commands (sent to the active PTY).
                this.app.exportQuickCommandsConfig(copyBtn);
            } else {
                this.app.exportModelsConfig(copyBtn);
            }
        });

        const pasteBtn = document.createElement('button');
        pasteBtn.className = 'dropup-config-btn';
        pasteBtn.title = mode === 'cmds' ? 'Paste commands config from clipboard' : 'Paste models config from clipboard';
        pasteBtn.innerHTML = '↓ Paste config';
        pasteBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (mode === 'cmds') {
                await this.app.importCmdsConfig(pasteBtn);
            } else {
                await this.app.importModelsConfig(pasteBtn);
            }
            document.querySelectorAll('.model-presets-dropup').forEach(d => d.classList.add('hidden'));
            const activeTab = this.getActiveTab();
            if (activeTab) {
                this.renderPresets(activeTab.coder);
            }
        });

        footer.appendChild(copyBtn);
        footer.appendChild(pasteBtn);
        dropup.appendChild(footer);
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

                    // Only notify if this tab is NOT currently active and focused, was a long-running task, and is NOT a shell/terminal tab.
                    const isShellTab = tab.coder === 'bash' || tab.coder === 'pwsh';
                    if (!isActiveAndVisible && isLongTask && !isShellTab) {
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
                    this.switchTab(tab.paneId, { userInitiated: true });
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
