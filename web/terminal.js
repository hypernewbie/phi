/* Φ phi — Terminal & Tab Manager */

import { PTYWebSocket } from './ws.js';
import { normalizePath } from './sessions.js';
import {
    projectWorktreeLabel,
    cpuLevel,
    worktreeGlyph,
    getTerminalActivityState,
    formatTerminalActivityTitle,
    buildSelfHud,
    formatHudLine,
    formatHudCpu,
    formatDurationMin,
    escapeHtml,
} from './util.js';
import {
    formatAttachment,
    extractImageItems,
    extractImageFiles,
    uploadClipboardImage,
    formatChipName,
} from './attachments.js';

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
        this.attachmentStrip = document.getElementById('attachment-strip');
        this.stagedAttachments = []; // Attachment[] — populated by drop/paste, drained by send
        this.lastCpuPercent = null; // updated by applyCPUIndicator; read by the self-HUD popover
        // Prompt history. Alt+Up / Alt+Down on the textarea cycles through
        // previously-sent prompts in the active cwd. _historyCursor is the
        // index into _historyCache for the currently-shown entry; -1 means
        // no entry shown (the textarea holds fresh text the user is typing).
        this._historyCache = [];      // newest-first: index 0 = most recent entry
        this._historyCursor = -1;     // -1 = free-form, ≥0 = showing cache[idx]
        this._historyCwd = '';        // cwd the cache was loaded for
        this._historyLoaded = false;  // first Alt+Up needs a fetch
        this.selfHudEl = document.getElementById('self-hud-popover');
        this.selfHudOpen = false;
        this.selfHudCloseTimer = null;
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
        // Cache for the self-state HUD so hovering doesn't trigger a fetch.
        // The HUD reads this on every render — polling keeps it fresh.
        this.lastCpuPercent = cpuPercent;
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
        this._stopDragAutoScroll();
    }

    // ---- Edge auto-scroll during drag --------------------------------
    //
    // Per-tab dragover only fires when the cursor is OVER a tab. The
    // empty whitespace between/after tabs gets nothing — so even with
    // overflow we can't drag past the visible window. This container-
    // level handler fires over the whitespace (with preventDefault so
    // dragover continues firing), and when the cursor is near the
    // left/right edge, ramps a small horizontal scroll so the strip
    // follows the cursor.
    //
    // Velocity ramp: closer to the edge = faster, capped at ~15px/frame.
    // 48px edge zone is wide enough on trackpads that you don't fight
    // the scroll, narrow enough that mid-strip drags stay put.
    //
    // STATIC so they're available even on `Object.create(prototype)`
    // test harnesses that skip the constructor.
    static _EDGE_ZONE_PX = 48;
    static _EDGE_MAX_VEL = 15; // px per animation frame

    _setupContainerDragHandlers() {
        const strip = this.tabsContainer;
        if (!strip || strip._dragHandlersWired) return;
        strip._dragHandlersWired = true;
        // Initialize drag-scroll state so callers reading from outside
        // (and tests) get 0 rather than undefined on a fresh instance.
        this._dragScrollDir = 0;
        this._dragScrollVel = 0;
        this._dragScrollRaf = null;

        const onDragOver = (e) => {
            // Only act if a tab is being dragged inside phi. If a file
            // from outside is dragged in we still want drop targets to
            // work via the per-tab handlers, but auto-scroll would be
            // a weird experience.
            if (!this.dragSourceId) return;
            const EDGE_ZONE_PX = TabManager._EDGE_ZONE_PX;
            const EDGE_MAX_VEL = TabManager._EDGE_MAX_VEL;
            const rect = strip.getBoundingClientRect();
            const x = e.clientX;
            let dir = 0;
            let prox = 0;
            if (x < rect.left + EDGE_ZONE_PX) {
                dir = -1;
                prox = (rect.left + EDGE_ZONE_PX - x) / EDGE_ZONE_PX;
            } else if (x > rect.right - EDGE_ZONE_PX) {
                dir = 1;
                prox = (x - (rect.right - EDGE_ZONE_PX)) / EDGE_ZONE_PX;
            }
            this._dragScrollDir = dir;
            this._dragScrollVel = Math.min(Math.max(prox, 0), 1) * EDGE_MAX_VEL;
            if (dir !== 0 && !this._dragScrollRaf) {
                this._dragScrollRaf = requestAnimationFrame(() => this._stepDragAutoScroll());
            }
            // The whitespace case: we still need to preventDefault so
            // that dragover keeps firing and the drop event is allowed.
            // The per-tab handler does this too, but only over tabs.
            if (!e.defaultPrevented) e.preventDefault();
            try { e.dataTransfer.dropEffect = 'move'; } catch (_) {}
        };

        const onDragLeave = (e) => {
            // Only when the cursor leaves the strip's bounding box
            // entirely (not when sliding between tabs/whitespace inside).
            const to = e.relatedTarget;
            if (to && strip.contains(to)) return;
            // Hit a tab and re-entered its dragover? per-tab keeps things
            // alive. We're only clearing edge-scroll when truly gone.
            // The dragend/drop on a tab will also clear via _stopDragAutoScroll.
        };

        strip.addEventListener('dragover', onDragOver);
        strip.addEventListener('dragleave', onDragLeave);

        // Container-level drop: fires when the user releases over
        // whitespace past the last tab (or before the first). Without
        // this the auto-scroll gets you there but the drop has no
        // target - the reorder silently no-ops.
        strip.addEventListener('drop', (e) => {
            // Only handle drops in the whitespace area. Per-tab drop
            // handlers have already eaten drops that fell on a tab.
            const targetTab = e.target.closest && e.target.closest('.tab');
            if (targetTab) return; // per-tab already handled
            e.preventDefault();
            this._stopDragAutoScroll();
            if (!this.dragSourceId) return;
            const order = Array.from(this.tabs.keys());
            const sourceIdx = order.indexOf(this.dragSourceId);
            if (sourceIdx < 0) {
                this.dragSourceId = null;
                return;
            }
            const rect = strip.getBoundingClientRect();
            // Cursor past the right edge -> append to end.
            // Cursor before the left edge -> prepend to start.
            const atEnd = e.clientX > rect.right - 4;
            order.splice(sourceIdx, 1);
            if (atEnd) order.push(this.dragSourceId);
            else order.unshift(this.dragSourceId);
            this.applyTabOrder(order);
            this.dragSourceId = null;
        });

        // Mouse wheel: when the strip is overflowing, map vertical wheel
        // to horizontal scroll. Trackpads handle this natively via deltaX
        // but most mice don't, so without this you can scroll horizontally
        // on a trackpad but not on a regular mouse. We do NOT prevent
        // default when there's no horizontal overflow so the page scrolls
        // normally.
        const onWheel = (e) => {
            const overflowX = strip.scrollWidth - strip.clientWidth;
            if (overflowX <= 4) return;
            // Trackpad horizontal gestures come through as deltaX. Mouse
            // vertical wheels come through as deltaY. We accept both.
            const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
            if (dx === 0) return;
            // Only consume the event when there's actually room to scroll
            // in the requested direction (so we don't trap a wheel that
            // overshoots).
            const before = strip.scrollLeft;
            strip.scrollLeft = Math.max(0, Math.min(
                strip.scrollWidth - strip.clientWidth,
                strip.scrollLeft + dx));
            if (strip.scrollLeft !== before) {
                e.preventDefault();
                this.updateTabOverflow();
            }
        };
        strip.addEventListener('wheel', onWheel, { passive: false });
    }

    _stepDragAutoScroll() {
        this._dragScrollRaf = null;
        if (!this._dragScrollDir) return;
        const strip = this.tabsContainer;
        if (!strip) return;
        // Velocity may have been set to 0 if cursor moved to mid-strip;
        // keep the rAF idling so it can pick back up on edge re-entry.
        if (this._dragScrollVel > 0) {
            strip.scrollLeft = Math.max(0, Math.min(
                strip.scrollWidth - strip.clientWidth,
                strip.scrollLeft + this._dragScrollDir * this._dragScrollVel));
            this.updateTabOverflow();
        }
        this._dragScrollRaf = requestAnimationFrame(() => this._stepDragAutoScroll());
    }

    _stopDragAutoScroll() {
        this._dragScrollDir = 0;
        this._dragScrollVel = 0;
        if (this._dragScrollRaf) {
            cancelAnimationFrame(this._dragScrollRaf);
            this._dragScrollRaf = null;
        }
    }

    handleTabDragOver(e, targetPaneId) {
        if (!this.dragSourceId || this.dragSourceId === targetPaneId) return;
        // Pin status no longer blocks drag targets - tabs default to
        // pinned so we can't gate on the class. Order is purely visual
        // and handled by moveTabTo's insert-before/after logic.
        const tabEl = e.currentTarget;
        if (!tabEl) return;
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

        // Hover preview card (glassmorphism, big hieroglyph). Shows on
        // mouseover of a tab so users can identify the worktree at a
        // glance without reading the path. Hides on mouseout or scroll.
        this._initHieroPreview();

        // Container-level drag-and-drop wiring: edge auto-scroll + drop-into-
        // whitespace. Per-tab drag handlers already handle dragover/drop on
        // tabs themselves; this covers the gaps.
        this._setupContainerDragHandlers();

        // Click/focus input bar → exit direct mode
        this.inputTextArea.addEventListener('focus', () => {
            const activeTab = this.getActiveTab();
            if (activeTab && activeTab.directMode) {
                activeTab.directMode = false;
                this.updateDirectModeUI(activeTab);
            }
            if (window.innerWidth <= 768) {
                // Only an input-focus transition may correct iOS WebKit's
                // focus-scroll. Generic page/terminal scrolling must never
                // be reset to the document origin.
                this.app.updateLayoutPosition?.(true, true);
                setTimeout(() => this.app.updateLayoutPosition?.(true, true), 50);
            }
        });

        this.inputTextArea.addEventListener('blur', () => {
            if (window.innerWidth <= 768) {
                // Refit after the keyboard hides, but do not reset document
                // scroll: the user may already be scrolling terminal output.
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
            // Cursor-reset-on-type for prompt history lives in
            // _initPromptHistoryKeydown's own 'input' listener (kept
            // separate so it's independently unit-testable).
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

        // Drag-and-drop and clipboard-paste attachments. Drop handler is on
        // .input-bar-container (not document) so tab-reorder drags on the
        // tabs strip don't conflict. Paste handler is on #input-textarea
        // so Cmd+V in the terminal pane still flows raw bytes to the PTY.
        this._initAttachmentDropZone();
        this._initAttachmentPasteHandler();
        this._initPromptHistoryKeydown();
        this._initBrandHud();

        // Global Ctrl+Shift+X -> send staged input. Fires regardless of
        // which element is focused (textarea, terminal, anywhere). The
        // chip only displays for pi, but the keybinding itself is
        // universally available since it's a quality-of-life shortcut.
        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey &&
                (e.key === 'X' || e.key === 'x')) {
                e.preventDefault();
                this.sendStagedInput();
                return;
            }
            // Mobile arrow-key capture fallback. On mobile the WebKit
            // soft keyboard sometimes yanks focus off the input bar
            // mid-type, so the per-textarea arrow handler at terminal.js:512
            // never fires. Capture arrow / Enter / Escape / PageUp /
            // PageDown at the document level whenever the staged input
            // is empty AND a tab is active. Desktop keeps the original
            // textarea-bound path; document-level capture would steal
            // arrow keys from terminal-internal tools (fzf, less, etc.)
            // on a real keyboard.
            if (window.innerWidth > 768) return;
            if (!this.inputTextArea || this.inputTextArea.value !== '') return;
            if (this.inputBarContainer?.classList.contains('hidden')) return;
            const activeTab = this.getActiveTab();
            if (!activeTab || activeTab.isDead) return;
            // Skip if a modal is open - let the modal handler have the key.
            if (document.querySelector('.modal-overlay:not(.hidden), .md-modal-overlay:not(.hidden)')) return;

            const mobileKeys = {
                'ArrowUp':    '\u001b[A',
                'ArrowDown':  '\u001b[B',
                'ArrowLeft':  '\u001b[D',
                'ArrowRight': '\u001b[C',
                'PageUp':     '\u001b[5~',
                'PageDown':   '\u001b[6~',
                'Enter':      '\r',
                'Escape':     '\u001b',
            };
            const sendChar = mobileKeys[e.key];
            if (sendChar !== undefined && !e.ctrlKey && !e.metaKey && !e.altKey) {
                e.preventDefault();
                this.sendInput(activeTab, sendChar);
                this._spamScrollToBottom(activeTab);
            }
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
                // Clicking the hostname opens its tab-selector dropdown
                // — close the brand HUD first so the two popovers never
                // coexist. Without this, the HUD stays open while the
                // hostname dropdown shows underneath (visible clash).
                if (typeof this._closeSelfHudNow === 'function') {
                    this._closeSelfHudNow();
                }
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

            const overflowDropdown = document.getElementById('tab-overflow-dropdown');
            if (overflowDropdown && !overflowDropdown.classList.contains('hidden')) {
                if (!e.target.closest('#tab-overflow-btn') && !e.target.closest('#tab-overflow-dropdown')) {
                    this._closeOverflowDropdown();
                }
            }
        });

        const overflowBtn = document.getElementById('tab-overflow-btn');
        if (overflowBtn) {
            overflowBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._toggleOverflowDropdown();
            });
        }

        // Passive scroll listener keeps the +N chip count in sync as the
        // user horizontally scrolls the strip. rAF-coalesced via a tiny
        // scheduler so we don't over-read.
        const strip = document.getElementById('tabs-container');
        if (strip) {
            let rafPending = false;
            const onScroll = () => {
                if (rafPending) return;
                rafPending = true;
                requestAnimationFrame(() => {
                    rafPending = false;
                    this.updateTabOverflow();
                });
            };
            strip.addEventListener('scroll', onScroll, { passive: true });
            // Also recompute on resize so a window resize properly reveals/hides the chip.
            window.addEventListener('resize', onScroll, { passive: true });
        }
    }
    
    getActiveTab() {
        return this.tabs.get(this.activePaneId);
    }

    // Browser chrome has a deliberately small, composable language:
    // Φ = all quiet, ϕ = a live terminal emitted output recently, and
    // the pre-existing leading ● remains exclusively for done/attention.
    // The header cursor mirrors only the live-output half of that state.
    updateDocumentTitle() {
        const state = getTerminalActivityState(this.tabs.values());
        document.title = formatTerminalActivityTitle(this.app.hostname, state);

        const indicator = document.getElementById('terminal-activity-indicator');
        if (indicator) {
            const hostnameKnown = Boolean(this.app.hostname);
            indicator.classList.toggle('hidden', !hostnameKnown);
            indicator.classList.toggle('is-active', state.hasActivity);
            indicator.textContent = state.hasActivity ? '▍' : '—';
            const label = state.hasActivity
                ? 'Terminal output on one or more tabs'
                : 'All terminal tabs are quiet';
            indicator.setAttribute('aria-label', label);
            indicator.title = label;
        }

        // App owns favicon generation; guard keeps TabManager independently
        // usable in focused tests and lightweight embeds.
        if (this.app && typeof this.app.setTerminalActivity === 'function') {
            this.app.setTerminalActivity(state.hasActivity);
        }
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
            // First byte after quiet is the only transition we need to render.
            // Subsequent writes stay in the same live-output state.
            this.updateDocumentTitle();
        }

        if (!tabInfo.writePending) {
            tabInfo.writePending = true;
            // Capture the user's pre-write scroll position so we can decide
            // whether to auto-follow bottom on the rAF tick. Standard
            // xterm "is-at-bottom" predicate, matching the scroll-to-bottom
            // button's check (viewportY >= baseY, no slack).
            const buf = tabInfo.term && tabInfo.term.buffer && tabInfo.term.buffer.active;
            const preAtBottom = buf && (buf.viewportY >= buf.baseY);
            requestAnimationFrame(() => {
                if (tabInfo.writeBuffer.length > 0 && !tabInfo.isDead) {
                    // write(data, cb): cb fires once the chunk is parsed into
                    // the buffer. Sync the DOM scroll area then — xterm leaves
                    // it stale during streaming (no reflow), which made the
                    // first wheel-up compute from a minutes-old scrollTop (the
                    // "jump") and wheel-down clamp before the real bottom (the
                    // "stuck below bottom" state). xterm is vendored/pinned
                    // (web/vendor/xterm.js), so reaching the core viewport is
                    // version-stable; syncScrollArea(true) is a no-op when
                    // already in sync.
                    tabInfo.term.write(tabInfo.writeBuffer, () => {
                        tabInfo.term._core?.viewport?.syncScrollArea(true);
                    });
                    tabInfo.writeBuffer = '';

                    // Force the scrollbar to reflect the new bottom.
                    // xterm's native syncScrollArea leaves the scrollbar
                    // stale when output grows without a layout reflow;
                    // the only reliable cross-version fix is an explicit
                    // scroll-to-bottom call. Respects userFollowBottom:
                    // if the user has scrolled up (flag = false), we
                    // honor that and leave the scroll position alone.
                    if (preAtBottom && tabInfo.userFollowBottom !== false) {
                        tabInfo.term.scrollToBottom();
                    }
                }
                tabInfo.writePending = false;
            });
        }
    }
    
    updateDirectModeUI(tab) {
        // Save scroll state before DOM changes alter the terminal height
        if (tab && !tab.isDead && tab.isAtBottom === undefined) {
            const buffer = tab.term.buffer.active;
            tab.isAtBottom = buffer.viewportY >= buffer.baseY;
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
    
    createTab(paneId, sessionId, title, coder, workspace = '', cwd = '', pinned = true, marked = false, initialCmd = '') {
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
        // Tabs default to pinned (server keeps the PTY alive across WS
        // disconnects / reloads). Pinning is a session-protection concept,
        // not a position-lock - all tabs get drag-reorder regardless of
        // pin state (moveTabTo / applyTabOrder / saveTabOrder).
        tabEl.draggable = true;
        tabEl.addEventListener('dragstart', (e) => this.handleTabDragStart(e, paneId));
        tabEl.addEventListener('dragend', (e) => this.handleTabDragEnd(e));
        tabEl.addEventListener('dragover', (e) => this.handleTabDragOver(e, paneId));
        tabEl.addEventListener('dragleave', (e) => this.handleTabDragLeave(e));
        tabEl.addEventListener('drop', (e) => this.handleTabDrop(e, paneId));
        
        // Stash the worktree glyph + cwd on the tab DOM so the legend, the
        // +N dropdown, and the hover preview can read them without a tabs
        // Map lookup (the Map entry lands ~300 lines later - see NOTE below).
        // No native title attribute: the hiero hover card is the tooltip,
        // and a title attr set here would go stale on rename anyway.
        const glyph = worktreeGlyph(cwd);
        tabEl.dataset.worktreeGlyph = glyph;
        tabEl.dataset.cwd = cwd;
        tabEl.innerHTML = `
            <button class="tab-pin" title="Pin session (Keep alive overnight)"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 12px; height: 12px;"><line x1="12" y1="17" x2="12" y2="22"></line><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"></path></svg></button>
            <img class="tab-favicon" src="${faviconUrl}" alt="${coder}">
            <span class="tab-worktree-icon" aria-hidden="true">${glyph}</span>
            <span class="tab-title ${marked ? 'marked' : ''}">${escapeHtml(title)}</span>
            <button class="tab-close">×</button>
            <button class="tab-reopen" title="Undo close">↻</button>
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
                <div class="loader-text">Starting ${escapeHtml(title)}...</div>
            `;
            termContainer.appendChild(loaderEl);
        }

        this.tabsContainer.appendChild(tabEl);
        this.terminalsWrapper.appendChild(termContainer);

        // Hide empty state landing page on tab creation
        this.hideEmptyState();

        // NOTE: overflow chip + sidebar legend refresh is intentionally
        // NOT done here. createTab() still has 300+ lines to go (PTY
        // spawn, WS attach, xterm.js fit, etc.) before this.tabs.set()
        // runs at line ~1247. Calling these here would render against
        // a tabs Map that's one tab behind, so the newest tab would be
        // missing from the legend and overflow count until the next
        // event happened to trigger a refresh. Both are called below
        // immediately after the tabs.set instead.
        
        tabEl.addEventListener('click', (e) => {
            const currentPaneId = tabEl.getAttribute('data-pane-id');
            if (e.target.closest('.tab-reopen')) {
                e.stopPropagation();
                this.undoCloseTab(currentPaneId);
                return;
            }
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

        tabEl.addEventListener('dblclick', (e) => {
            const titleEl = e.target.closest('.tab-title');
            if (!titleEl) return;
            e.preventDefault();
            e.stopPropagation();
            const currentPaneId = tabEl.getAttribute('data-pane-id');
            this.openTabRenamer(currentPaneId, titleEl);
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
            fontSize: (this.app && this.app.terminalFontSize >= 8 && this.app.terminalFontSize <= 32) ? this.app.terminalFontSize : (isMobile ? 10 : 14),
            fontFamily: (this.app && this.app.terminalFontFamily) || 'JetBrains Mono, monospace',
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
                // preventDefault: focus moves to the textarea mid-keydown, so
                // without it the browser's default insertion lands there too
                // and doubles the character.
                e.preventDefault();
                this.inputTextArea.value += e.key;
                this.inputTextArea.focus({ preventScroll: true });
                const len = this.inputTextArea.value.length;
                this.inputTextArea.setSelectionRange(len, len);
                // Synthetic 'input': preventDefault suppresses the native one,
                // but the textarea's input listeners (spam-scroll,
                // lastInputValue, autosize, prompt-history cursor reset)
                // still need to run.
                this.inputTextArea.dispatchEvent(new Event('input', { bubbles: true }));
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
            // Per-coder default focus mode. Shell tabs (bash, pwsh) and btop
            // open in focused/direct mode — keyboard goes straight to the
            // terminal, no input bar visible. AI-coder tabs (pi, claude,
            // agy, opencode) keep the staged-input flow as default because
            // that's the whole phi workflow: queue prompts, attach files,
            // Ctrl+Shift+X chip. DirectMode is not persisted — restored
            // tabs pick this up via createTab() on each load.
            directMode: (coder === 'bash' || coder === 'pwsh'),
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
            hasStarted: false,
            // Scrollbar follow mode. xterm's native syncScrollArea leaves
            // the scrollbar stale when PTY output grows without a layout
            // reflow (e.g., the input bar auto-resize that fires when the
            // user types). Tracking this flag separately lets us:
            //   - Snap to bottom on PTY output when at bottom (real follow)
            //   - Stop overriding xterm's scroll position when user wheels up
            //   - Re-engage follow if user scrolls back to bottom
            // Without it, the scrollbar shows the line from N minutes ago
            // while content scrolls past, then snaps when the user wheels.
            userFollowBottom: true
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
            () => this._handleTerminalDisconnect(tabInfo),
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

        // A real scroll gesture takes ownership away from any in-flight
        // fit/reflow restore. Do not use term.onScroll for this: xterm emits
        // it for our own programmatic scrolls too, which would weaken the
        // proven 10ms/300ms stabilization loop. DOM input events identify
        // user intent without changing that loop's timing or behavior.
        const cancelFollowForUserScroll = () => this._cancelScrollFollowForUserScroll(tabInfo);
        termContainer.addEventListener('wheel', cancelFollowForUserScroll, { capture: true, passive: true });
        termContainer.addEventListener('touchstart', cancelFollowForUserScroll, { capture: true, passive: true });
        term.element?.querySelector('.xterm-viewport')?.addEventListener(
            'pointerdown', cancelFollowForUserScroll, { capture: true, passive: true },
        );

        // Escape hatch: when the DOM scroll area is stale, wheel-down clamps
        // at a fake bottom while real output sits below (viewportY < baseY).
        // Detect the clamp and scroll the buffer directly — reaching the true
        // bottom re-engages follow via the scroll listeners in the button
        // block below. Registered bubble-phase so the opencode capture
        // handler's stopPropagation keeps opencode tabs out of this path.
        termContainer.addEventListener('wheel', (e) => {
            if (e.deltaY <= 0) return;
            const buf = tabInfo.term && tabInfo.term.buffer && tabInfo.term.buffer.active;
            if (!buf || buf.viewportY >= buf.baseY) return;
            const vp = tabInfo.term.element && tabInfo.term.element.querySelector('.xterm-viewport');
            if (!vp) return;
            if (vp.scrollTop + vp.clientHeight >= vp.scrollHeight - 1) {
                // Same wheel→lines scaling as the opencode handler above.
                const lines = Math.max(1, Math.min(Math.round(e.deltaY / 40), 8));
                tabInfo.term.scrollLines(lines);
            }
        }, { passive: true });

        // Scroll-to-bottom affordance: a small floating button that
        // fades in when the user scrolls up into scrollback, fades out
        // when they return to the live bottom. Click jumps to the
        // bottom. Pattern is universal in TUI/web-terminal apps (iTerm,
        // VS Code terminal, Hyper, etc.) and removes the daily friction
        // of "I scrolled up to read something, now I can't find my way
        // back to live output."
        //
        // MUST come AFTER `const tabInfo = { ... }`. The TDZ scope for
        // a `const` starts at the top of the enclosing block, so any
        // `tabInfo.X = ...` assignment above the declaration throws
        // "Cannot access 'tabInfo' before initialization" at runtime.
        // Earlier revisions put this block right after `term.open()`
        // which is BEFORE the tabInfo declaration and broke every
        // spawn-new-session. Keep it after this.tabs.set().
        const scrollToBottomBtn = document.createElement('button');
        scrollToBottomBtn.className = 'scroll-to-bottom-btn hidden';
        scrollToBottomBtn.setAttribute('type', 'button');
        scrollToBottomBtn.setAttribute('aria-label', 'Jump to bottom of output');
        scrollToBottomBtn.title = 'Jump to bottom';
        scrollToBottomBtn.innerHTML = '\u2193'; // ↓
        scrollToBottomBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            tabInfo.term.scrollToBottom();
            this._spamScrollToBottom(tabInfo);
            // Explicit jump-to-bottom click re-engages follow mode.
            tabInfo.userFollowBottom = true;
            scrollToBottomBtn.classList.add('hidden');
        });
        termContainer.appendChild(scrollToBottomBtn);
        tabInfo.scrollToBottomBtn = scrollToBottomBtn;

        const updateScrollBtn = () => {
            if (tabInfo.isDead || tabInfo.coder === 'review' || tabInfo.coder === 'kanban') {
                scrollToBottomBtn.classList.add('hidden');
                return;
            }
            const buf = tabInfo.term && tabInfo.term.buffer && tabInfo.term.buffer.active;
            if (!buf) return;
            const atBottom = buf.viewportY >= buf.baseY;
            if (atBottom) {
                scrollToBottomBtn.classList.add('hidden');
            } else {
                scrollToBottomBtn.classList.remove('hidden');
            }
        };
        if (term.onScroll) {
            term.onScroll(updateScrollBtn);
            // Re-engage follow mode when the user scrolls back to bottom.
            // Wheel/touch inputs disabled follow by setting
            // userFollowBottom = false; this reverses it once they return
            // to the live tail. Lets the user "release" and re-follow
            // without needing to click Jump-to-bottom.
            term.onScroll(() => {
                const b = tabInfo.term && tabInfo.term.buffer && tabInfo.term.buffer.active;
                if (b && b.viewportY >= b.baseY) {
                    tabInfo.userFollowBottom = true;
                }
            });
        }
        // xterm's public onScroll fires only for PROGRAMMATIC scrolls: the
        // vendored build passes suppressScrollEvent=true for user wheel /
        // scrollbar input (Viewport._handleScroll), so the two onScroll
        // subscriptions above never fire for real user gestures. The DOM
        // 'scroll' event is the signal those gestures do produce. It does
        // not bubble — listen in the capture phase on termContainer. The
        // capture listener fires BEFORE xterm's own scroll handler updates
        // the buffer, so defer one frame (house rAF-coalesce pattern) to
        // read fresh coordinates.
        let viewportScrollRafPending = false;
        termContainer.addEventListener('scroll', () => {
            if (viewportScrollRafPending) return;
            viewportScrollRafPending = true;
            requestAnimationFrame(() => {
                viewportScrollRafPending = false;
                updateScrollBtn();
                const b = tabInfo.term && tabInfo.term.buffer && tabInfo.term.buffer.active;
                if (b && b.viewportY >= b.baseY) {
                    tabInfo.userFollowBottom = true;
                }
            });
        }, { capture: true, passive: true });
        // Also re-evaluate on every write so a button shown while
        // scrolled up hides itself once new output catches up to bottom.
        const origWrite = tabInfo.term.write.bind(tabInfo.term);
        tabInfo.term.write = (data, cb) => {
            const r = origWrite(data, cb);
            updateScrollBtn();
            return r;
        };

        // Refresh overflow chip NOW that the tab is registered in
        // this.tabs. Previously this was called much earlier in
        // createTab (line ~899) which left the overflow chip one tab
        // behind until something else triggered a re-render. Now it
        // always reflects the full tab set.
        this.updateTabOverflow();

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
                tab.isAtBottom = buffer.viewportY >= buffer.baseY;
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

    // A user-initiated finalization closes the PTY WebSocket too. Its
    // onclose callback is asynchronous, so it can arrive after the tab
    // teardown starts; that expected close must not masquerade as a lost
    // terminal or offer to reconnect a tab the user just closed.
    _handleTerminalDisconnect(tabInfo) {
        if (tabInfo.finalizing) return;

        tabInfo.term.write('\r\n\x1b[31m[Connection lost]\x1b[0m\r\n');
        tabInfo.isDead = true;
        tabInfo.tabEl.classList.add('dead');
        this.updateDocumentTitle();
        this._showReconnectOverlay(tabInfo);
        this.updateDisconnectBanner();
        this.maybeAutoReconnect(tabInfo);
        // Toast so the user notices the drop even when they're focused on
        // a different tab. The on-terminal reconnect overlay stays for the
        // local UX; this toast covers the peripheral case.
        if (this.app && this.app.showToast) {
            this.app.showToast(
                `Connection lost on "${tabInfo.title || tabInfo.coder || 'tab'}"`,
                {
                    type: 'error',
                    title: 'Terminal disconnected',
                    duration: 8000,
                    action: tabInfo.exitCode === undefined || tabInfo.exitCode === null
                        ? { text: 'Reconnect', callback: () => this.reconnectTab(tabInfo) }
                        : null,
                },
            );
        }
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
                prevTab.isAtBottom = prevTab.term.buffer.active.viewportY >= prevTab.term.buffer.active.baseY;
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
            if (this.app.markdownManager) {
                this.app.markdownManager.refreshFiles({ force: false, silent: true });
            }
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

    openTabRenamer(paneId, titleEl) {
        const tab = this.tabs.get(paneId);
        if (!tab) return;
        const current = tab.title || '';

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'rename-input tab-title';
        input.value = current;
        titleEl.replaceWith(input);
        input.focus({ preventScroll: true });
        input.select();

        let done = false;
        const commit = () => {
            if (done) return;
            done = true;
            const next = input.value.trim();
            const span = document.createElement('span');
            span.className = `tab-title ${tab.marked ? 'marked' : ''}`;
            if (next && next !== current) {
                tab.title = next;
                span.textContent = next;
                if (!tab.isReview && !tab.isKanban) this.syncBackendTitle(paneId, next);
            } else {
                span.textContent = current;
            }
            input.replaceWith(span);
        };
        const cancel = () => {
            if (done) return;
            done = true;
            const span = document.createElement('span');
            span.className = `tab-title ${tab.marked ? 'marked' : ''}`;
            span.textContent = current;
            input.replaceWith(span);
        };

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        });
        input.addEventListener('blur', commit);
    }

    syncBackendTitle(paneId, title) {
        fetch(`/api/terminals/${paneId}/title`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title })
        }).catch(err => console.error('[term] Failed to sync title on backend:', err));
    }

    // Soft-close: when the user clicks × on a tab, the tab doesn't actually
    // go away for SOFT_CLOSE_GRACE_MS - it stays in the strip faded out
    // with a ↻ reopen button, and an "Undo" toast is shown. This solves
    // two real problems:
    //   1. Accidental close was a hard cliff: PTY killed, WS closed, term
    //      disposed — no way back. Now the user has SOFT_CLOSE_GRACE_MS
    //      to click Undo (in the toast) or click the ↻ icon (in the
    //      strip) to restore the tab.
    //   2. closeTab used to auto-switch to whatever happened to be last in
    //      the Map (insertion order), which had no relationship to the
    //      user's current project. Now soft-close never auto-switches:
    //      the active tab is kept in place under a spinner overlay so
    //      the user can see what they're losing and still hit undo.
    // If the user doesn't undo within the grace, finalizeCloseTab()
    // actually kills the PTY and removes the tab.
    //
    // MAX_SOFT_CLOSED_TABS caps how many faded tabs can sit in the strip
    // at once - past that, the oldest is force-finalized to keep the
    // strip readable.
    static SOFT_CLOSE_GRACE_MS = 3000;
    static MAX_SOFT_CLOSED_TABS = 3;

    closeTab(paneId) {
        const tab = this.tabs.get(paneId);
        if (!tab) return;

        // If already soft-closing, the user clicked × again - treat it as
        // "I really mean it" and finalize immediately. They can still
        // click Undo in the toast within the grace window if it changed
        // their mind, but normally this just shortens the grace.
        if (tab.softClosing) {
            this.finalizeCloseTab(paneId);
            return;
        }

        this.softCloseTab(paneId);
    }

    // Mark tab as soft-closing: strip entry fades, × swaps to ↻, a tiny
    // countdown pill appears on the strip so the user can see how long
    // they have to undo. The PTY is NOT killed yet — if the user clicks
    // ↻, or the "Undo" button in the toast, the tab is restored.
    //
    // The active tab is NOT auto-switched on close. Instead, a content
    // overlay covers the terminal with the same spinner + countdown so
    // the user can still see what they were looking at while they
    // decide whether to undo. After the 3s grace (or × twice), if the
    // tab was the only one, the empty state finally shows.
    softCloseTab(paneId) {
        const tab = this.tabs.get(paneId);
        if (!tab || tab.softClosing) return;

        tab.softClosing = true;
        tab.softCloseStartedAt = Date.now();
        tab.tabEl.classList.add('soft-closed');

        // Cap: if too many soft-closed tabs in the strip, force-finalize
        // the oldest. This keeps the strip readable and bounds the grace
        // memory footprint.
        const softTabs = Array.from(this.tabs.values()).filter(t => t.softClosing);
        if (softTabs.length > TabManager.MAX_SOFT_CLOSED_TABS) {
            softTabs.sort((a, b) => (a.softCloseStartedAt || 0) - (b.softCloseStartedAt || 0));
            this.finalizeCloseTab(softTabs[0].paneId);
            return;
        }

        // Active-tab close: keep the user where they are. Spin up a
        // countdown overlay on top of the terminal so they can see
        // what they're "losing" and still hit undo. No tab switch, no
        // surprise "where did my view go" jump.
        if (this.activePaneId === paneId) {
            this._showSoftCloseOverlay(tab);
        }

        // Strip pill: a tiny "5s → 4s" countdown next to the title so
        // the fading tab itself communicates "you have N seconds to
        // bring me back." Visible even when the closing tab is not the
        // active one — keeps the affordance consistent.
        this._startSoftCloseCountdown(tab);

        // Undo toast for ALL soft-closes (active or background). The
        // toast auto-dismisses after the grace; clicking Undo restores.
        if (this.app && this.app.showToast) {
            const toastEl = this.app.showToast(
                `Closed "${tab.title || tab.coder || 'tab'}"`,
                {
                    type: 'info',
                    title: 'Tab closed',
                    duration: TabManager.SOFT_CLOSE_GRACE_MS,
                    action: {
                        text: 'Undo',
                        callback: () => this.undoCloseTab(paneId),
                    },
                },
            );
            // showToast returns the toast element so we can dismiss it
            // early if the user undoes via the ↻ button (otherwise two
            // dismissals race) or if the cap forces a finalize.
            tab.softCloseToast = toastEl;
        }

        // Schedule finalization.
        tab.softCloseTimer = setTimeout(() => {
            this.finalizeCloseTab(paneId);
        }, TabManager.SOFT_CLOSE_GRACE_MS);
    }

    // Build the content-area overlay shown when the active tab is
    // soft-closing: dark backdrop + spinner ring (drain animation) +
    // countdown text + "click ↻ to undo" hint. Sits on top of the
    // terminal so the user keeps visual context while they decide.
    // Removed on undo or finalize.
    _showSoftCloseOverlay(tab) {
        if (!tab.termContainer) return;
        // Pull the worktree hieroglyph from the tab so the countdown
        // carries the same visual identity as the tab itself - a tiny
        // Egyptian wall detail that ties the close-back state to the
        // worktree it's closing in.
        const glyph = (tab.tabEl && tab.tabEl.dataset.worktreeGlyph) || '◆';
        const overlay = document.createElement('div');
        overlay.className = 'tab-soft-close-overlay';
        overlay.innerHTML = `
            <div class="tab-soft-close-backdrop" aria-hidden="true">${glyph}</div>
            <div class="tab-soft-close-ring" aria-hidden="true">
                <svg viewBox="0 0 56 56">
                    <circle class="tab-soft-close-ring-bg" cx="28" cy="28" r="24"/>
                    <circle class="tab-soft-close-ring-fg" cx="28" cy="28" r="24"
                            pathLength="100" stroke-dasharray="100" stroke-dashoffset="0"/>
                </svg>
                <div class="tab-soft-close-ring-center">${glyph}</div>
            </div>
            <div class="tab-soft-close-text">
                Closing in <span class="tab-soft-close-secs">5</span>s<span class="tab-soft-close-ellipsis"><span class="d1">.</span><span class="d2">.</span><span class="d3">.</span></span>
            </div>
            <div class="tab-soft-close-hint">Click ↻ in the tab strip to undo</div>
            <button class="tab-soft-close-undo" type="button">↻ Undo close</button>
        `;
        // The undo button on the overlay itself: previously the only
        // affordances were the tiny ↻ in the tab strip (easy to miss
        // when the closing tab fills the screen) and the corner toast.
        // Now the closing-tab motif carries its own restore button.
        const undoBtn = overlay.querySelector('.tab-soft-close-undo');
        if (undoBtn) {
            undoBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                this.undoCloseTab(tab.paneId);
            });
        }
        tab.termContainer.appendChild(overlay);
        tab.softCloseOverlay = overlay;
        // Tick the count text + ellipsis pulse while the overlay is up.
        // Reusing _startSoftCloseCountdown's tick() would be ideal but
        // it owns its own interval; the overlay updates the count via a
        // dedicated loop that stops when the overlay is removed.
        this._tickSoftCloseOverlay(tab);
    }

    _tickSoftCloseOverlay(tab) {
        if (!tab.softCloseOverlay) return;
        const startedAt = tab.softCloseStartedAt || Date.now();
        const duration = TabManager.SOFT_CLOSE_GRACE_MS;
        const tick = () => {
            if (!tab.softCloseOverlay) return; // overlay gone -> stop
            const elapsed = Date.now() - startedAt;
            const remaining = Math.max(0, Math.ceil((duration - elapsed) / 1000));
            const secsEl = tab.softCloseOverlay.querySelector('.tab-soft-close-secs');
            if (secsEl) secsEl.textContent = String(remaining);
            if (remaining <= 0) return;
        };
        tick();
        tab.softCloseOverlayTimer = setInterval(tick, 250);
    }

    // Tick a tiny countdown pill on the tab strip entry itself, so users
    // closing inactive tabs (who don't get the content overlay) still
    // see how long until finalize. Stops cleanly on undo / finalize.
    _startSoftCloseCountdown(tab) {
        const startedAt = tab.softCloseStartedAt || Date.now();
        const duration = TabManager.SOFT_CLOSE_GRACE_MS;
        const glyph = (tab.tabEl && tab.tabEl.dataset.worktreeGlyph) || '◆';
        const pill = document.createElement('span');
        pill.className = 'tab-soft-close-pill';
        pill.innerHTML = `
            <span class="tab-soft-close-pill-glyph">${glyph}</span>
            <span class="tab-soft-close-pill-text">5s</span>
        `;
        tab.tabEl.appendChild(pill);
        tab.softClosePill = pill;
        const textEl = pill.querySelector('.tab-soft-close-pill-text');
        const tick = () => {
            const elapsed = Date.now() - startedAt;
            const remaining = Math.max(0, Math.ceil((duration - elapsed) / 1000));
            if (textEl) textEl.textContent = `${remaining}s`;
            if (remaining <= 0) {
                if (tab.softClosePillTimer) clearInterval(tab.softClosePillTimer);
                tab.softClosePillTimer = null;
                return;
            }
        };
        tick();
        tab.softClosePillTimer = setInterval(tick, 250);
    }

    _stopSoftCloseCountdown(tab) {
        if (tab.softClosePillTimer) {
            clearInterval(tab.softClosePillTimer);
            tab.softClosePillTimer = null;
        }
        if (tab.softClosePill) {
            tab.softClosePill.remove();
            tab.softClosePill = null;
        }
    }

    _removeSoftCloseOverlay(tab) {
        if (tab.softCloseOverlayTimer) {
            clearInterval(tab.softCloseOverlayTimer);
            tab.softCloseOverlayTimer = null;
        }
        if (tab.softCloseOverlay) {
            tab.softCloseOverlay.remove();
            tab.softCloseOverlay = null;
        }
    }

    // Reverse a soft-close: cancel the timer, restore the strip entry,
    // switch back to the tab. Works whether the user clicked Undo in the
    // toast or the ↻ icon in the strip.
    undoCloseTab(paneId) {
        const tab = this.tabs.get(paneId);
        if (!tab || !tab.softClosing) return;

        if (tab.softCloseTimer) {
            clearTimeout(tab.softCloseTimer);
            tab.softCloseTimer = null;
        }
        if (tab.softCloseToast) {
            // External dismiss: remove the .show class so CSS animates it
            // out, then drop from DOM after the 200ms transition.
            tab.softCloseToast.classList.remove('show');
            setTimeout(() => tab.softCloseToast?.remove(), 200);
            tab.softCloseToast = null;
        }
        this._stopSoftCloseCountdown(tab);
        this._removeSoftCloseOverlay(tab);

        tab.softClosing = false;
        tab.softCloseStartedAt = null;
        tab.tabEl.classList.remove('soft-closed');

        this.switchTab(paneId, { userInitiated: true });
    }

    // Actually kill the PTY, close WS, dispose term, drop from Map.
    // Called by the grace timer, by the cap-forced finalize, or by
    // closeTab's "user clicked × twice" path. Idempotent: a single
    // setTimeout + cap-forced-finalize-from-the-newest-close + a
    // double-× click can all race for the same pane; this is
    // guarded so DELETE fires exactly once per tab.
    finalizeCloseTab(paneId) {
        const tab = this.tabs.get(paneId);
        if (!tab) return;
        // Re-entry guard: if finalization is already in progress (from
        // another entry point), don't fire a second DELETE or run the
        // cleanup twice. We use this flag instead of relying on
        // tabs.delete() as the gate, because the delete happens *after*
        // the fetch — the second caller would otherwise race the first.
        if (tab.finalizing) return;
        tab.finalizing = true;

        if (tab.softCloseTimer) {
            clearTimeout(tab.softCloseTimer);
            tab.softCloseTimer = null;
        }
        if (tab.softCloseToast) {
            tab.softCloseToast.classList.remove('show');
            setTimeout(() => tab.softCloseToast?.remove(), 200);
            tab.softCloseToast = null;
        }
        this._stopSoftCloseCountdown(tab);
        this._removeSoftCloseOverlay(tab);

        // Kill the server-side PTY process. We previously swallowed
        // failures with .catch(() => {}) — that hid the actual user
        // bug ("process never gets closed"). Now we surface non-2xx and
        // network errors as a toast so the user knows the PTY may still
        // be alive on the server (e.g. a race with another tab close,
        // network blip, or 5xx). The 30-min detach grace timer is the
        // server-side backstop either way.
        fetch(`/api/terminals/${paneId}`, { method: 'DELETE' })
            .then((res) => {
                if (!res.ok && res.status !== 404) {
                    // 404 is fine — it just means another caller already
                    // killed the instance. Anything else (5xx, network,
                    // CORS) is worth telling the user about.
                    throw new Error(`DELETE returned ${res.status}`);
                }
            })
            .catch((err) => {
                console.error('[tab] failed to kill PTY for', paneId, err);
                if (this.app && this.app.showToast) {
                    this.app.showToast(
                        `Could not close "${tab.title || paneId}" on the server — the underlying process may still be running. Try "Restart phi" if it persists.`,
                        { type: 'error', duration: 8000 }
                    );
                }
            });

        try { if (tab.ws) tab.ws.close(); } catch (e) { console.error("[tab] WS close error:", e); }
        try { if (tab.term) tab.term.dispose(); } catch (e) { console.error("[tab] Term dispose error:", e); }
        try {
            if (tab.tabEl) tab.tabEl.remove();
            if (tab.termContainer) tab.termContainer.remove();
        } catch (e) { console.error("[tab] DOM removal error:", e); }

        // BUG-3 fix: notify the per-coder manager so it can tear down
        // listeners and overlays it added.
        if (this.app.kanbanManager && tab.isKanban) {
            this.app.kanbanManager.cleanup();
        }
        if (this.app.reviewManager && tab.isReview) {
            this.app.reviewManager.cleanup?.();
        }

        this.tabs.delete(paneId);
        this.updateDocumentTitle();
        this.updateDisconnectBanner();
        this.saveTabsState();

        // Refresh overflow chip to reflect the removal.
        this.updateTabOverflow();

        // If we just finalized the last tab, show the empty state now
        // (no overlay was up because grace expired without undo).
        if (this.tabs.size === 0) {
            this.activePaneId = null;
            this.inputBarContainer.classList.add('hidden');
            this.presetsContainer.classList.add('hidden');
            this.showEmptyState();
            if (this.app.markdownManager) {
                this.app.markdownManager.refreshFiles({ force: true });
            }
        } else if (this.activePaneId === paneId) {
            // Active tab finalized while other tabs exist (rare:
            // grace expired without undo). Pick the most recently
            // surviving tab. We intentionally do NOT auto-switch on
            // soft-close (see softCloseTab) — this fallback only runs
            // when the user let the grace expire on a non-last tab.
            const remaining = Array.from(this.tabs.values());
            if (remaining.length > 0) {
                const survivor = remaining[remaining.length - 1];
                this.switchTab(survivor.paneId, { userInitiated: false });
            }
        }
    }

    // pickNextTab was removed: soft-close never auto-switches anymore.
    // The user stays on the closing tab via the spinner overlay until
    // they either undo or let the grace expire. The previous priority
    // chain (same workspace + coder, then same workspace, etc.) caused
    // silent jumps to a different project on accidental close -
    // worse than the problem it tried to solve.

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

    // ---- Tab overflow + worktree legend ----------------------------
    //
    // The +N "more" chip lives at the right edge of the tabs bar.
    // It only appears when scrolled-off tabs exist. Click opens a
    // dropdown listing ALL tabs (grouped by worktree glyph) so the
    // user can jump to any tab without scrolling blindly. The
    // sidebar legend summarizes the open worktrees at a glance.

    updateTabOverflow() {
        const strip = document.getElementById('tabs-container');
        const btn = document.getElementById('tab-overflow-btn');
        if (!strip || !btn) return;
        const overflowX = strip.scrollWidth - strip.clientWidth;
        if (overflowX <= 4) {
            btn.classList.add('hidden');
            btn.setAttribute('aria-expanded', 'false');
            return;
        }
        // Count tabs whose left edge is past the visible right edge.
        const stripRect = strip.getBoundingClientRect();
        let hiddenCount = 0;
        for (const tabEl of strip.querySelectorAll('.tab')) {
            const tabRect = tabEl.getBoundingClientRect();
            if (tabRect.left >= stripRect.right - 1) hiddenCount += 1;
            else if (tabRect.right > stripRect.right + 1 && tabRect.left > stripRect.left) {
                // Partially-clipped tab: count it as hidden too. Treat
                // the half-tab as "effectively offscreen" since the
                // important info (title, x) may be clipped.
                if (tabRect.right - stripRect.right > tabRect.width / 2) hiddenCount += 1;
            }
        }
        if (hiddenCount <= 0) {
            btn.classList.add('hidden');
            btn.setAttribute('aria-expanded', 'false');
            return;
        }
        btn.classList.remove('hidden');
        const label = btn.querySelector('.tab-overflow-btn-label');
        if (label) label.textContent = `+${hiddenCount} more`;
        btn.setAttribute('aria-expanded', btn.getAttribute('aria-expanded') === 'true' ? 'true' : 'false');
    }

    // ----- Hover preview card -------------------------------------------------
    //
    // A single shared element (#tab-hiero-preview, appended to <body>) shows
    // the hieroglyph large with the worktree label and full path when the
    // user mouses over a tab. Lets users identify which worktree a tab
    // belongs to without reading the path - especially useful after
    // we moved the pool from 12 generic glyphs to 96 distinct Egyptian
    // hieroglyphs, where each glyph is much more memorable.
    _initHieroPreview() {
        if (this._hieroPreview) return;
        const el = document.createElement('div');
        el.className = 'tab-hiero-preview';
        el.id = 'tab-hiero-preview';
        el.setAttribute('aria-hidden', 'true');
        el.innerHTML = `
            <div class="tab-hiero-preview-glyph"></div>
            <div class="tab-hiero-preview-title"></div>
            <div class="tab-hiero-preview-label"></div>
            <div class="tab-hiero-preview-path"></div>
            <div class="tab-hiero-preview-count"></div>
            <div class="tab-hiero-preview-status"></div>
        `;
        document.body.appendChild(el);
        this._hieroPreview = el;
        this._hieroPreviewGlyph = el.querySelector('.tab-hiero-preview-glyph');
        this._hieroPreviewTitle = el.querySelector('.tab-hiero-preview-title');
        this._hieroPreviewLabel = el.querySelector('.tab-hiero-preview-label');
        this._hieroPreviewPath = el.querySelector('.tab-hiero-preview-path');
        this._hieroPreviewCount = el.querySelector('.tab-hiero-preview-count');
        this._hieroPreviewStatus = el.querySelector('.tab-hiero-preview-status');

        // Event delegation on the tabs container - one listener, works for
        // every tab and any tab created later (event bubbles up).
        if (this.tabsContainer) {
            // relatedTarget guard: mouseover/mouseout fire on every
            // child-boundary crossing inside a tab; only react when the
            // pointer actually enters/leaves the tab, so the preview
            // (and its shimmer) doesn't replay on intra-tab movement.
            this.tabsContainer.addEventListener('mouseover', (e) => {
                const tabEl = e.target.closest('.tab');
                if (tabEl && !tabEl.contains(e.relatedTarget)) this._showHieroPreview(tabEl);
            });
            this.tabsContainer.addEventListener('mouseout', (e) => {
                const tabEl = e.target.closest('.tab');
                if (tabEl && !tabEl.contains(e.relatedTarget)) this._hideHieroPreview();
            });
        }
        // Sidebar worktree headers also drive the preview: hovering a
        // worktree section in the left panel shows a medium-sized glyph
        // so users can verify the right worktree before clicking.
        const sessionList = document.getElementById('session-list');
        if (sessionList) {
            sessionList.addEventListener('mouseover', (e) => {
                const headerEl = e.target.closest('.worktree-header');
                if (headerEl && !headerEl.contains(e.relatedTarget)) this._showWorktreeHieroPreview(headerEl);
            });
            sessionList.addEventListener('mouseout', (e) => {
                const headerEl = e.target.closest('.worktree-header');
                if (headerEl && !headerEl.contains(e.relatedTarget)) this._hideHieroPreview();
            });
        }
        // Hide on scroll/resize so the preview never lags behind a moved tab.
        // Cheap idempotent hide; cheap idempotent show on next mouseover.
        window.addEventListener('scroll', () => this._hideHieroPreview(), true);
        window.addEventListener('resize', () => this._hideHieroPreview());
    }

    // Show the preview for a tab. Anchor: below the tab (default large size).
    _showHieroPreview(tabEl) {
        const p = this._hieroPreview;
        if (!p) return;
        const paneId = tabEl.dataset.paneId;
        const tab = this.tabs.get(paneId);
        // Even if we don't have a tab record yet (mid-createTab), we can
        // still show what we know from the DOM data attributes.
        const glyph = tabEl.dataset.worktreeGlyph || '◆';
        const label = (tab && this.getProjectWorktreeLabel(tab.cwd)) || '—';
        const path = (tab && tab.cwd) || tabEl.dataset.cwd || '';

        // Title read at hover-time, never stashed, so renames and truncated
        // tab strips always resolve to the current full title. Mid-createTab
        // the Map entry doesn't exist yet - the .tab-title span does.
        const titleSpan = tabEl.querySelector('.tab-title');
        const titleText = (tab && tab.title) || (titleSpan ? titleSpan.textContent : '');

        // Live status line - coder-agnostic, from the client-side busy/idle
        // tracking every PTY tab gets (isBusy set on output frames, cleared
        // by the idle sweep). Review/kanban tabs have neither field, so the
        // row stays empty and :empty CSS hides it.
        let statusText = '';
        let busy = false;
        if (tab && tab.isBusy) {
            busy = true;
            statusText = `● busy ${formatDurationMin(Date.now() - (tab.busyStartTime || Date.now()))}`;
        } else if (tab && typeof tab.lastOutputAt === 'number') {
            statusText = `idle · last output ${formatDurationMin(Date.now() - tab.lastOutputAt)} ago`;
        }

        // Count tabs sharing this hieroglyph - lets users see "you have
        // 3 tabs in this worktree" at a glance from the preview.
        let count = 0;
        for (const t of this.tabs.values()) {
            if (t.tabEl && t.tabEl.dataset.worktreeGlyph === glyph) count++;
        }

        this._populateHieroPreview({
            glyph, titleText, label, path, sourceEl: tabEl, anchor: 'below', size: 'large',
            countText: count > 1
                ? `${count} tabs in this worktree`
                : (count === 1 ? '1 tab in this worktree' : ''),
            statusText, busy,
        });
    }

    // Show the preview for a sidebar worktree header. Anchor: right of the
    // header (medium size so it doesn't compete with the tab preview for
    // visual weight).
    _showWorktreeHieroPreview(headerEl) {
        const p = this._hieroPreview;
        if (!p) return;
        const section = headerEl.closest('.worktree-section');
        const path = section ? section.getAttribute('data-worktree-path') : '';
        const glyphEl = headerEl.querySelector('.worktree-section-glyph');
        const glyph = glyphEl ? glyphEl.textContent : '◆';
        const nameEl = headerEl.querySelector('.worktree-name');
        const label = nameEl ? nameEl.textContent : (path ? path.split(/[/\\]/).pop() : '—');

        // How many tabs would land in this worktree if opened here? Lets
        // the user gauge whether the worktree already has a session
        // before clicking. Cheap: just count open tabs whose cwd matches.
        let count = 0;
        if (path) {
            for (const t of this.tabs.values()) {
                if (t.cwd === path) count++;
            }
        }
        this._populateHieroPreview({
            glyph, label, path, sourceEl: headerEl, anchor: 'right', size: 'medium',
            countText: count > 0
                ? `${count} tab${count === 1 ? '' : 's'} open in this worktree`
                : 'no tabs open in this worktree',
        });
    }

    // Common populate + show path. Sets the card text + position based
    // on anchor (below|right) and size (large|medium). titleText/statusText
    // are tab-hover-only; worktree headers leave them empty and the rows
    // collapse via :empty CSS.
    _populateHieroPreview({ glyph, titleText, label, path, sourceEl, anchor, size, countText, statusText, busy }) {
        const p = this._hieroPreview;
        if (!p) return;

        // Toggle the size modifier. Only one size at a time so the
        // transition between sources is clean (e.g., user hovers a
        // tab then a worktree header).
        p.classList.toggle('tab-hiero-preview-medium', size === 'medium');
        p.classList.toggle('is-busy', !!busy);

        this._hieroPreviewGlyph.textContent = glyph;
        this._hieroPreviewTitle.textContent = titleText || '';
        this._hieroPreviewLabel.textContent = label || '—';
        this._hieroPreviewPath.textContent = path || '';
        this._hieroPreviewCount.textContent = countText || '';
        this._hieroPreviewStatus.textContent = statusText || '';

        // Position. Fixed positioning uses viewport coords, so we don't
        // need to account for scroll. Both anchors clamp so the card
        // never leaves the viewport.
        const rect = sourceEl.getBoundingClientRect();
        if (anchor === 'right') {
            const left = rect.right + 8;
            const maxLeft = window.innerWidth - 260;
            p.style.left = `${Math.min(maxLeft, left)}px`;
            p.style.top = `${Math.max(8, rect.top)}px`;
            // Worktree side: card is medium so its width is mostly
            // content-driven; CSS caps at 260px.
            p.style.minWidth = '';
        } else {
            // below
            p.style.left = `${Math.max(8, Math.min(window.innerWidth - 200, rect.left))}px`;
            p.style.top = `${rect.bottom + 8}px`;
            // Tabs vary in width; widen the card a bit so the long
            // paths don't wrap awkwardly. CSS caps at 320px.
            p.style.minWidth = `${Math.max(180, rect.width)}px`;
        }

        // Re-trigger the shimmer keyframe by clearing and re-setting
        // animation - forces a reflow so the animation restarts each
        // hover instead of only playing on first show.
        this._hieroPreviewGlyph.style.animation = 'none';
        void this._hieroPreviewGlyph.offsetWidth;
        this._hieroPreviewGlyph.style.animation = '';

        p.classList.add('visible');
    }

    _hideHieroPreview() {
        if (this._hieroPreview) {
            this._hieroPreview.classList.remove('visible');
        }
    }

    _buildOverflowDropdown() {
        const dropdown = document.getElementById('tab-overflow-dropdown');
        if (!dropdown) return null;
        dropdown.innerHTML = '';
        if (this.tabs.size === 0) {
            const empty = document.createElement('div');
            empty.style.padding = '12px';
            empty.style.color = 'var(--text-muted)';
            empty.textContent = 'No tabs open';
            dropdown.appendChild(empty);
            return dropdown;
        }

        // Group by worktree glyph (== by cwd). Stable insertion order
        // matches first-seen-in-tabs-Map order so a tab the user just
        // created appears in the section their cursor is on.
        const groups = new Map();
        for (const [paneId, tab] of this.tabs.entries()) {
            const glyph = (tab.tabEl && tab.tabEl.dataset.worktreeGlyph) || '◆';
            const label = this.getProjectWorktreeLabel(tab.cwd);
            if (!groups.has(glyph)) groups.set(glyph, { label, items: [] });
            groups.get(glyph).items.push({ paneId, tab });
        }
        for (const [glyph, group] of groups.entries()) {
            const header = document.createElement('div');
            header.className = 'tab-overflow-dropdown-group';
            const icon = document.createElement('span');
            icon.className = 'tab-overflow-dropdown-group-icon';
            icon.textContent = glyph;
            const text = document.createElement('span');
            text.textContent = group.label;
            const count = document.createElement('span');
            count.style.marginLeft = 'auto';
            count.textContent = `${group.items.length} tab${group.items.length === 1 ? '' : 's'}`;
            header.appendChild(icon);
            header.appendChild(text);
            header.appendChild(count);
            dropdown.appendChild(header);

            for (const { paneId, tab } of group.items) {
                const row = document.createElement('div');
                row.className = 'hostname-dropdown-row';
                row.dataset.paneId = paneId;
                if (paneId === this.activePaneId) row.classList.add('active');

                const selectBtn = document.createElement('button');
                selectBtn.className = 'hostname-dropdown-select-btn';
                const faviconImg = document.createElement('img');
                faviconImg.className = 'hostname-dropdown-favicon';
                faviconImg.src = tab.faviconUrl || '';
                faviconImg.alt = tab.coder || '';
                const titleSpan = document.createElement('span');
                titleSpan.className = 'hostname-dropdown-title';
                titleSpan.innerText = tab.title || 'Session';
                selectBtn.appendChild(faviconImg);
                selectBtn.appendChild(titleSpan);
                selectBtn.addEventListener('click', () => {
                    this.switchTab(paneId, { userInitiated: true });
                    this._closeOverflowDropdown();
                });
                row.appendChild(selectBtn);

                const closeBtn = document.createElement('button');
                closeBtn.className = 'hostname-dropdown-close-btn';
                closeBtn.innerHTML = '×';
                closeBtn.title = 'Close session';
                closeBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.closeTab(paneId);
                    // Re-render after async finalize so the row disappears.
                    setTimeout(() => {
                        if (!this._overflowDropdownHidden()) this._buildOverflowDropdown();
                    }, 50);
                });
                row.appendChild(closeBtn);
                dropdown.appendChild(row);
            }
        }

        // Auto-scroll to the active row so users land on it.
        const active = dropdown.querySelector('.hostname-dropdown-row.active');
        if (active && active.scrollIntoView) {
            active.scrollIntoView({ block: 'nearest' });
        }
        return dropdown;
    }

    _overflowDropdownHidden() {
        const dd = document.getElementById('tab-overflow-dropdown');
        return !dd || dd.classList.contains('hidden');
    }

    _toggleOverflowDropdown() {
        const dd = document.getElementById('tab-overflow-dropdown');
        const btn = document.getElementById('tab-overflow-btn');
        if (!dd || !btn) return;
        const open = dd.classList.contains('hidden');
        if (open) {
            this._buildOverflowDropdown();
            dd.classList.remove('hidden');
            btn.setAttribute('aria-expanded', 'true');
        } else {
            this._closeOverflowDropdown();
        }
    }

    _closeOverflowDropdown() {
        const dd = document.getElementById('tab-overflow-dropdown');
        const btn = document.getElementById('tab-overflow-btn');
        if (dd) dd.classList.add('hidden');
        if (btn) btn.setAttribute('aria-expanded', 'false');
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

    // _initAttachmentDropZone wires drag-and-drop file ingestion. The drop
    // zone is intentionally broader than just the input bar: users drop
    // where their cursor is, which is usually the terminal pane, not the
    // narrow input strip. The page-wide dragover handler gives visual
    // feedback (input bar glows) regardless of cursor position. The
    // drop handler routes file drops from anywhere except the tabs
    // strip (which has its own reorder handler) to the attachment
    // pipeline.
    //
    // Visual feedback: input bar glows via `.is-drop-target` whenever a
    // file is being dragged anywhere on the page. Uses existing --accent
    // tokens — no new colours per AGENTS.md.
    _initAttachmentDropZone() {
        if (!this.inputBarContainer) return;

        // Page-wide dragover: prevent default (required so drop fires)
        // and toggle the visual feedback class on the input bar.
        // Skip when the drag isn't a file (text/uri-list no-op cleanly).
        const isFileDrag = (e) => {
            const dt = e.dataTransfer;
            if (!dt || !dt.types) return false;
            return Array.from(dt.types).includes('Files');
        };

        document.addEventListener('dragover', (e) => {
            if (!isFileDrag(e)) return;
            e.preventDefault();
            try { e.dataTransfer.dropEffect = 'copy'; } catch (_) {}
            this.inputBarContainer.classList.add('is-drop-target');
        });

        // dragleave fires on every child boundary; gate by counter so
        // moving across the page keeps the glow on.
        let dragDepth = 0;
        document.addEventListener('dragenter', (e) => {
            if (!isFileDrag(e)) return;
            e.preventDefault();
            dragDepth += 1;
            this.inputBarContainer.classList.add('is-drop-target');
        });
        document.addEventListener('dragleave', (e) => {
            dragDepth = Math.max(0, dragDepth - 1);
            if (dragDepth === 0) {
                this.inputBarContainer.classList.remove('is-drop-target');
            }
        });
        document.addEventListener('drop', async (e) => {
            // Skip if the drop landed inside a tab — the per-tab drop
            // handler manages tab reordering. Use closest('.tab') rather
            // than a stored tabsContainer reference so this check stays
            // correct across TabManager instances and test resets.
            if (e.target && e.target.closest && e.target.closest('.tab')) return;
            if (!isFileDrag(e)) return;
            e.preventDefault();
            dragDepth = 0;
            this.inputBarContainer.classList.remove('is-drop-target');
            const files = extractImageFiles(e.dataTransfer.files);
            for (const file of files) {
                try {
                    const attachment = await uploadClipboardImage(file, file.name || 'dropped');
                    attachment.source = 'drop';
                    this._addAttachmentChip(attachment);
                } catch (err) {
                    this._attachmentToast(`Drop failed: ${err.message}`);
                }
            }
        });
    }

    // _initAttachmentPasteHandler intercepts image-bearing pastes on the
    // textarea. Text-only pastes fall through to default behavior so
    // pasting a URL into the prompt still works normally.
    //
    // The handler is on the textarea, NOT document — if focus is on the
    // terminal pane, Cmd+V flows raw bytes into the PTY as before. This
    // is the only correct way to not break paste-in-terminal.
    _initAttachmentPasteHandler() {
        if (!this.inputTextArea) return;
        this.inputTextArea.addEventListener('paste', async (e) => {
            const items = extractImageItems(e.clipboardData);
            if (items.length === 0) return; // text paste → let browser handle
            e.preventDefault();
            for (const item of items) {
                const blob = item.getAsFile && item.getAsFile();
                if (!blob) continue;
                try {
                    const attachment = await uploadClipboardImage(blob, 'clipboard.png');
                    this._addAttachmentChip(attachment);
                } catch (err) {
                    this._attachmentToast(`Paste failed: ${err.message}`);
                }
            }
        });
    }

    // (Removed _initDocumentDropGuard: the page-wide dragover/drop handlers
// in _initAttachmentDropZone now do both preventDefault AND the upload
// in one place, so a separate "guard" listener is redundant.)

    // _initPromptHistoryKeydown wires Alt+Up / Alt+Down on the staged
    // input textarea to cycle through previously-sent prompts (see
    // _cyclePromptHistory). Kept as its own listener — separate from the
    // big Enter/Escape/arrows keydown handler — so it's easy to unit-test
    // in isolation, matching the _initAttachmentDropZone /
    // _initAttachmentPasteHandler pattern.
    _initPromptHistoryKeydown() {
        if (!this.inputTextArea) return;
        this.inputTextArea.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowUp' && e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
                e.preventDefault();
                this._cyclePromptHistory('older');
                return;
            }
            if (e.key === 'ArrowDown' && e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
                e.preventDefault();
                this._cyclePromptHistory('newer');
                return;
            }
        });
        // Any user-typed character breaks the history-cycle: the
        // textarea is now the user's own draft, not a stored entry.
        // Cursor goes back to -1 so the next Alt+Up starts from the
        // most-recent stored entry.
        this.inputTextArea.addEventListener('input', () => {
            this._historyCursor = -1;
        });
    }

    // _addAttachmentChip stores the attachment and re-renders the strip.
    _addAttachmentChip(attachment) {
        // De-dupe by path: same file dropped twice shouldn't chip twice.
        if (this.stagedAttachments.some((a) => a.path === attachment.path)) return;
        this.stagedAttachments.push(attachment);
        this._renderAttachmentStrip();
    }

    // _removeAttachmentChip removes a single attachment by id.
    _removeAttachmentChip(id) {
        this.stagedAttachments = this.stagedAttachments.filter((a) => a.id !== id);
        this._renderAttachmentStrip();
    }

    // _renderAttachmentStrip repaints the chip strip from stagedAttachments.
    // Idempotent — called on add/remove/send.
    _renderAttachmentStrip() {
        if (!this.attachmentStrip) return;
        this.attachmentStrip.innerHTML = '';
        if (this.stagedAttachments.length === 0) {
            this.attachmentStrip.classList.add('hidden');
            return;
        }
        this.attachmentStrip.classList.remove('hidden');
        for (const a of this.stagedAttachments) {
            const chip = document.createElement('span');
            chip.className = 'attachment-chip';
            chip.setAttribute('data-id', a.id);
            chip.title = a.path;

            const icon = document.createElement('span');
            icon.className = 'attachment-icon';
            icon.textContent = a.source === 'paste' ? '⎘' : '⎗';
            chip.appendChild(icon);

            const name = document.createElement('span');
            name.className = 'attachment-name';
            name.textContent = formatChipName(a.name, 40);
            chip.appendChild(name);

            const size = document.createElement('span');
            size.className = 'attachment-size';
            size.textContent = this._formatSize(a.sizeBytes);
            chip.appendChild(size);

            const remove = document.createElement('button');
            remove.className = 'attachment-remove';
            remove.setAttribute('aria-label', 'Remove attachment');
            remove.textContent = '✕';
            remove.addEventListener('click', () => this._removeAttachmentChip(a.id));
            chip.appendChild(remove);

            this.attachmentStrip.appendChild(chip);
        }
    }

    _formatSize(bytes) {
        if (!Number.isFinite(bytes) || bytes < 0) return '';
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    _attachmentToast(message) {
        if (this.app && typeof this.app.showToast === 'function') {
            this.app.showToast(message, { type: 'error', title: 'Attachments' });
        } else {
            console.warn('[attachments]', message);
        }
    }

    // _initBrandHud wires hover/focus on the top-left Φ logo to open the
    // self-state HUD popover. No fetch on open/close — every field is
    // computed from local state (hostname, version, tab map, CPU sample).
    //
    // The popover lives in index.html as a sibling of .brand inside
    // .app-header, but on init we reparent it to <body> so it escapes
    // .app-header's z-index:100 stacking context. Without that reparent,
    // .diff-panel (z-index:1200) and .modal-overlay (z-index:10000)
    // cover the popover and steal its hover events.
    _initBrandHud() {
        const brand = document.querySelector('.brand');
        if (!brand) return;
        this.brandEl = brand;
        // Make the brand discoverable as interactive for keyboard users.
        if (!brand.hasAttribute('tabindex')) brand.setAttribute('tabindex', '0');
        if (!brand.hasAttribute('role')) brand.setAttribute('role', 'button');
        if (!brand.getAttribute('aria-describedby')) {
            brand.setAttribute('aria-describedby', 'self-hud-popover');
        }

        // Reparent the popover to <body> so its z-index competes in the
        // root stacking context. Idempotent — no-op if already there.
        if (this.selfHudEl && this.selfHudEl.parentNode !== document.body) {
            document.body.appendChild(this.selfHudEl);
        }

        // Reopen cooldown: ignore open triggers (mouseenter / focus) for
        // this many ms after a close. Prevents the flicker race where the
        // HUD closes (e.g. on outside-click), the cursor happens to be
        // still over the brand, and the next mouseenter reopens it.
        let lastClosedAt = 0;
        const HUD_REOPEN_COOLDOWN_MS = 200;

        const open = () => {
            if (this.selfHudCloseTimer) {
                clearTimeout(this.selfHudCloseTimer);
                this.selfHudCloseTimer = null;
            }
            if (Date.now() - lastClosedAt < HUD_REOPEN_COOLDOWN_MS) return;
            this._renderSelfHud();
            this._openSelfHud();
        };
        const scheduleClose = (delay = 150) => {
            if (this.selfHudCloseTimer) clearTimeout(this.selfHudCloseTimer);
            // Stamp lastClosedAt immediately so any subsequent mouseenter
            // during the fade-out falls inside the cooldown window.
            lastClosedAt = Date.now();
            this.selfHudCloseTimer = setTimeout(() => {
                this.selfHudCloseTimer = null;
                this._closeSelfHud();
            }, delay);
        };
        // closeNow is the "no-grace" close path: clears any pending timer,
        // stamps the cooldown, and closes synchronously. Used by every
        // close trigger except the mouseleave scheduler.
        const closeNow = () => {
            if (this.selfHudCloseTimer) {
                clearTimeout(this.selfHudCloseTimer);
                this.selfHudCloseTimer = null;
            }
            lastClosedAt = Date.now();
            this._closeSelfHud();
        };
        // Expose closeNow so hostname-click and other consumers don't
        // need to duplicate the cooldown bookkeeping.
        this._closeSelfHudNow = closeNow;

        brand.addEventListener('mouseenter', open);
        brand.addEventListener('focus', open);
        brand.addEventListener('mouseleave', () => scheduleClose());
        brand.addEventListener('blur', () => scheduleClose(0));

        // Hovering the hostname area must NOT open the HUD — the hostname
        // has its own click behavior (toggles the tab-selector dropdown)
        // and a HUD + tab-selector both opening would clash visually.
        // Close any open HUD when the cursor enters the hostname wrapper,
        // whether via direct entry or lateral movement from the logo.
        const hostnameWrapper = brand.querySelector('.hostname-wrapper');
        if (hostnameWrapper) {
            hostnameWrapper.addEventListener('mouseenter', () => {
                if (this.selfHudOpen) closeNow();
            });
        }

        // Keep the popover open if the cursor moves onto it (grace period).
        if (this.selfHudEl) {
            this.selfHudEl.addEventListener('mouseenter', () => {
                if (this.selfHudCloseTimer) {
                    clearTimeout(this.selfHudCloseTimer);
                    this.selfHudCloseTimer = null;
                }
            });
            this.selfHudEl.addEventListener('mouseleave', () => scheduleClose());
        }

        // Track scroll/resize while open so the popover follows the brand
        // when the layout shifts. capture:true ensures we catch scrolls on
        // any container (not just window). passive:true keeps it cheap.
        if (this.selfHudEl) {
            window.addEventListener('scroll', () => {
                if (this.selfHudOpen) this._positionSelfHud();
            }, { capture: true, passive: true });
            window.addEventListener('resize', () => {
                if (this.selfHudOpen) this._positionSelfHud();
            });
        }

        // Esc closes the popover if focus is on the brand. Listening on
        // brand (not document) keeps scope narrow and avoids leaking
        // listeners across test instances.
        brand.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.selfHudOpen) {
                e.preventDefault();
                closeNow();
                brand.focus({ preventScroll: true });
            }
        });

        // Touch-only click toggle: on devices without hover (phones,
        // tablets), tap brand to open, tap again to close. On
        // mouse-driven devices, hover owns opening/closing; clicks pass
        // through to the outside-click handler below.
        const isTouch = typeof window.matchMedia === 'function'
            && window.matchMedia('(hover: none)').matches;
        if (isTouch) {
            brand.addEventListener('click', (e) => {
                if (e.target.closest('button, .hostname-wrapper')) return;
                if (this.selfHudOpen) closeNow();
                else open();
            });
        }

        // Outside-click closes. Clicks inside the brand or the popover
        // are skipped (the brand's own click handler is responsible for
        // those, and we don't want to fight with it).
        document.addEventListener('click', (e) => {
            if (!this.selfHudOpen) return;
            const t = e.target;
            if (t.closest && (t.closest('.brand') || t.closest('#self-hud-popover'))) return;
            closeNow();
        });
    }

    _openSelfHud() {
        if (!this.selfHudEl) return;
        this._positionSelfHud();
        this.selfHudEl.classList.remove('hidden');
        this.selfHudEl.classList.add('is-open');
        this.selfHudEl.setAttribute('aria-hidden', 'false');
        this.selfHudOpen = true;
    }

    // _positionSelfHud anchors the popover to the brand's current
    // viewport rect. Called on every open and on scroll/resize while
    // open. Inline style.top/.left beat any CSS rule, which is what
    // we want for dynamic positioning.
    _positionSelfHud() {
        if (!this.selfHudEl || !this.brandEl) return;
        const rect = this.brandEl.getBoundingClientRect();
        this.selfHudEl.style.top = `${Math.round(rect.bottom + 10)}px`;
        this.selfHudEl.style.left = `${Math.round(rect.left)}px`;
    }

    _closeSelfHud() {
        if (!this.selfHudEl) return;
        this.selfHudEl.classList.remove('is-open');
        this.selfHudEl.setAttribute('aria-hidden', 'true');
        this.selfHudOpen = false;
        // Hide from layout after the fade-out so it doesn't intercept clicks.
        setTimeout(() => {
            if (!this.selfHudOpen) this.selfHudEl.classList.add('hidden');
        }, 220);
    }

    // _renderSelfHud paints the popover from local state. Pure DOM
    // mutation — no network. Re-run on every open so the values are
    // current as of the most recent open event.
    _renderSelfHud() {
        if (!this.selfHudEl) return;
        const version = (this.app && this.app.versionInfo && this.app.versionInfo.version) || '';
        const hud = buildSelfHud({
            hostname: (this.app && this.app.hostname) || '',
            version,
            cpuPercent: typeof this.lastCpuPercent === 'number' ? this.lastCpuPercent : null,
            tabs: this.tabs.values(),
        });

        // CPU-driven emphasis class on the popover so the cpu line tints
        // when load climbs. Matches the brand-logo class names.
        const level = hud.cpuPercent != null ? cpuLevel(hud.cpuPercent) : 'cpu-idle';
        for (const cls of ['cpu-idle', 'cpu-moderate', 'cpu-high', 'cpu-critical']) {
            this.selfHudEl.classList.remove(cls);
        }
        this.selfHudEl.classList.add(level);

        const workingGlyph = hud.busy > 0
            ? '<span class="glyph glyph-working" title="Working">ϕ</span>'
            : '<span class="glyph glyph-idle" title="Idle">Φ</span>';
        const attentionGlyph = hud.attention > 0
            ? '<span class="glyph glyph-attention" title="Needs attention">☥</span>'
            : '';

        const versionBit = hud.version
            ? `<span class="self-hud-version">v${escapeHtml(hud.version)}</span>`
            : '';
        const hostBit = hud.hostname
            ? `<span class="glyph">Φ</span><span class="self-hud-host-name">${escapeHtml(hud.hostname)}</span>`
            : '<span class="glyph">Φ</span><span class="self-hud-host-name">phi</span>';

        this.selfHudEl.innerHTML = `
            <div class="self-hud-header">
                <span class="self-hud-host">${hostBit}</span>
                ${versionBit}
            </div>
            <div class="self-hud-rule" aria-hidden="true"></div>
            <div class="self-hud-metrics">
                <span class="metric">
                    <span class="metric-count">${hud.sessions}</span>
                    <span class="metric-label">session${hud.sessions === 1 ? '' : 's'}</span>
                </span>
                <span class="metric glyph-working">
                    ${workingGlyph}
                    <span class="metric-count">${hud.busy}</span>
                    <span class="metric-label">working</span>
                </span>
                ${hud.attention > 0 ? `
                <span class="metric glyph-attention">
                    ${attentionGlyph}
                    <span class="metric-count">${hud.attention}</span>
                    <span class="metric-label">attention</span>
                </span>` : ''}
            </div>
            <div class="self-hud-footer">
                <span class="cpu">${escapeHtml(formatHudCpu(hud))}</span>
                <span class="dim">${escapeHtml(formatHudLine(hud))}</span>
            </div>
        `;
    }

    sendStagedInput() {
        const activeTab = this.getActiveTab();
        if (!activeTab) return;

        const val = this.inputTextArea.value;
        const attachments = this.stagedAttachments;
        // Empty guard now also allows attachments-only sends. Without
        // this, "drop a screenshot, hit Send with no text" silently
        // does nothing — a confusing dead end.
        if (!val && attachments.length === 0) return;

        // Compose payload: text first (if any), then one formatted
        // attachment path per line. Path formatting is per-active-tab
        // coder (claude → @path, bash → raw path).
        const coder = activeTab.coder;
        const lines = [];
        if (val && val.trim()) lines.push(val.trim());
        for (const a of attachments) {
            lines.push(formatAttachment(coder, a));
        }
        let payload = lines.join('\n');

        // Wrap in bracketed paste markers for large prompts or multiline text
        // to prevent TUI trickle-rendering / autocomplete lagging.
        if (payload.length > 16 || payload.includes('\n')) {
            payload = '\x1b[200~' + payload + '\x1b[201~';
        }

        // No isDead pre-check: sendInput() toasts + shows the reconnect overlay on failure.
        const sent = this.sendInput(activeTab, payload + '\r');
        if (!sent) return;

        // Record this prompt into ~/.phi/prompt_history.json BEFORE
        // clearing the textarea. Fire-and-forget so a slow disk
        // doesn't hold up the send. The backend handles dedup / cap
        // (FIFO at 100 entries, per-cwd filter).
        const sentText = val && val.trim() ? val.trim() : '';
        if (sentText) {
            const cwdForHistory = (this.app.sessionsManager && this.app.sessionsManager.activeCWD) || '';
            fetch('/api/prompt-history/append', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: sentText, cwd: cwdForHistory }),
            }).catch((err) => console.warn('[prompt_history] append failed', err));
            // Reset history cursor — user just sent fresh text, cycling
            // should start back at the most-recent prior entry.
            this._historyCursor = -1;
        }

        this.inputTextArea.value = '';
        this.lastInputValue = '';
        this.stagedAttachments = [];
        this._renderAttachmentStrip();
        this.adjustInputHeight();
        this._spamScrollToBottom(activeTab);

        // Auto sync clipboard on /copy command
        if (val && val.includes('/copy')) {
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

    /**
     * Send input to a SPECIFIC tab — does NOT re-resolve the active tab.
     * Thin wrapper over sendInput() (which owns the disconnect toast +
     * reconnect overlay) plus the scroll follow-up. Deliberately does NOT
     * steal focus — delayed callbacks must not refocus a tab the user has
     * switched away from. Use from setTimeout chains or anywhere the
     * active tab may have changed between scheduling and firing.
     */
    sendToTab(tabInfo, payload) {
        const sent = this.sendInput(tabInfo, payload);
        if (sent) this._spamScrollToBottom(tabInfo);
        return sent;
    }

    /**
     * Sends a slash command as one atomic bracketed-paste write. pkg/pty's
     * Write() (pty.go:235) splits the trailing \r into its own ConPTY write
     * with a crGapDur pause, so Enter registers as a distinct keypress on
     * Windows with no frontend delay needed. Same atomic form the
     * initial-cmd path (terminal.js:1421) has always used. Replaces the
     * prior split (sendRawInput + setTimeout(sendRawInput('\r'), 200))
     * which re-resolved the active tab in the delayed callback.
     * Called synchronously at click time (tab is still active), so it
     * preserves sendRawInput's focus behavior.
     */
    sendSlashCommand(tabInfo, cmd) {
        const sent = this.sendToTab(tabInfo, `\x1b[200~${cmd}\x1b[201~\r`);
        if (!sent) return false;
        const isMobile = window.innerWidth <= 768;
        if (isMobile && !tabInfo.directMode && this.inputTextArea) {
            this.inputTextArea.focus({ preventScroll: true });
        } else {
            this.focusActiveTerminal();
        }
        return true;
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
            this.updateDocumentTitle();
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
        } else if (control.type === 'md-changed') {
            // fsnotify push: a watched markdown dir changed on disk. Every
            // open pane WS receives the broadcast, so MarkdownManager
            // debounces client-side.
            if (this.app.markdownManager) {
                this.app.markdownManager.onExternalChange(control);
            }
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
                        this.updateDocumentTitle();
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
                    // A reconnect starts quiet. Without this reset, a PTY
                    // that disconnected while busy would revive the ϕ mark
                    // before it had emitted any new output.
                    tabInfo.isBusy = false;
                    tabInfo.lastOutputAt = undefined;
                    tabInfo.tabEl.classList.remove('dead');
                    this.updateDocumentTitle();
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
                        this.updateDocumentTitle();
                        this._showReconnectOverlay(tabInfo);
                        this.updateDisconnectBanner();
                    }
                },
                () => {
                    opened = true;
                    tabInfo.isDead = false;
                    tabInfo.isBusy = false;
                    tabInfo.lastOutputAt = undefined;
                    tabInfo.tabEl.classList.remove('dead');
                    this.updateDocumentTitle();
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

    // A wheel, touch, or native scrollbar-thumb gesture is an explicit user
    // choice. Cancel only the currently pending restore; `_spamScroll` itself
    // remains the established 10ms / 300ms mechanism for non-interrupted
    // resize, reflow, output, and explicit bottom-follow paths. Also flips
    // userFollowBottom to false so PTY output arriving in this state
    // doesn't snap the viewport back to bottom.
    _cancelScrollFollowForUserScroll(tabInfo) {
        if (!tabInfo) return;
        clearInterval(tabInfo.spamInterval);
        clearTimeout(tabInfo.stopSpamTimeout);
        tabInfo.spamInterval = null;
        tabInfo.stopSpamTimeout = null;
        tabInfo.isSpammingBottom = undefined;
        tabInfo.spamScrollY = undefined;
        tabInfo.userFollowBottom = false;
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
            activeTab.isAtBottom = buffer.viewportY >= buffer.baseY;
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
            const size = (this.app && this.app.terminalFontSize >= 8 && this.app.terminalFontSize <= 32) ? this.app.terminalFontSize : (isMobile ? 10 : 14);
            if (activeTab.term.options.fontSize !== size) {
                activeTab.term.options.fontSize = size;
            }

            // Capture scroll state PRE-FIT
            const buffer = activeTab.term.buffer.active;
            let isAtBottom;
            let scrollY;
            
            // If we are resizing continuously, cache these stable coordinates on the tab
            if (this.isResizing) {
                isAtBottom = activeTab.isAtBottom !== undefined ? activeTab.isAtBottom : (buffer.viewportY >= buffer.baseY);
                scrollY = activeTab.lastScrollY !== undefined ? activeTab.lastScrollY : buffer.viewportY;
                activeTab.isAtBottom = isAtBottom;
                activeTab.lastScrollY = scrollY;
            } else if (activeTab.spamInterval && activeTab.isSpammingBottom !== undefined) {
                // If a spam scroll is already trying to force the scroll position, respect its intended target 
                // instead of capturing a mid-flight coordinate.
                isAtBottom = activeTab.isSpammingBottom;
                scrollY = activeTab.spamScrollY;
            } else {
                isAtBottom = (buffer.viewportY >= buffer.baseY);
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

        // Mobile external-keyboard focus: when a tab becomes active on a
        // phone with an external keyboard attached, the user's typing
        // intent is unambiguous — they want to type into the staged
        // input bar. Without this, focus stays on the previous tab's
        // xterm and the user has to tap the input bar before their hw
        // keyboard routes anywhere. Desktop keeps the original path
        // (focus on xterm) so terminal-internal tools still capture
        // keys normally. Direct mode still wins — if the tab is in
        // direct mode, the xterm is where the user is typing.
        if (window.innerWidth <= 768 && !tabInfo.directMode && !tabInfo.isDead
            && this.inputTextArea && !this.inputBarContainer?.classList.contains('hidden')
            && !document.querySelector('.modal-overlay:not(.hidden), .md-modal-overlay:not(.hidden)')) {
            setTimeout(() => this.inputTextArea.focus({ preventScroll: true }), 80);
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
                            // Atomic paste+Enter. pkg/pty's crGapDur handles
                            // the ConPTY Enter quirk at the PTY layer; pi-tui
                            // re-feeds bytes after \x1b[201~ through
                            // handleInput so the Enter registers with no
                            // frontend delay. Same form the initial-cmd
                            // path has always used.
                            this.sendSlashCommand(activeTab, cmd);
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

        // 2b. Pi-specific shortcut chip: lives in the presets row alongside
        // /quit /resume /model /compact, with the same flat preset-btn
        // shape (no kbd-key caps / glow, no extra id, no title, label
        // matches the existing binding convention — lowercase, no
        // separator, no action-verb suffix). Visible only when the
        // active tab is a pi session. Clicking sends the staged input
        // — same as Send ↵. The keyboard binding itself is global
        // (document-level keydown listener below) and works whether
        // the chip is rendered.
        if (coderId === 'pi') {
            const chip = document.createElement('button');
            chip.className = 'preset-btn';
            chip.innerText = 'ctrl+shift+x';
            chip.addEventListener('click', () => {
                this.sendStagedInput();
            });
            this.presetsContainer.appendChild(chip);
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
                    // Atomic paste+Enter (see sibling site above).
                    this.sendSlashCommand(activeTab, cmd);
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

            // Worktree hieroglyph — same glyph shown on the tab itself.
            // Ties the dropdown row to its worktree group at a glance.
            const glyphSpan = document.createElement('span');
            glyphSpan.className = 'hostname-dropdown-glyph';
            glyphSpan.setAttribute('aria-hidden', 'true');
            glyphSpan.textContent = (tabInfo.tabEl && tabInfo.tabEl.dataset.worktreeGlyph) || '◆';

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
            selectBtn.appendChild(glyphSpan);
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
                    // Pinned to the click-time tab (captured at render, line 4376)
                    // so the puppet sequence can't be redirected by a tab switch
                    // mid-chain. Timing unchanged from prior behavior.
                    this.sendToTab(activeTab, '/models');
                    setTimeout(() => {
                        this.sendToTab(activeTab, '\r');
                        setTimeout(() => {
                            this.sendToTab(activeTab, model);
                            setTimeout(() => {
                                this.sendToTab(activeTab, '\r');
                            }, 350);
                        }, 350);
                    }, 350);
                } else if (backend === 'pi') {
                    // /model [PAUSE]name[PAUSE]<Enter>.
                    //
                    // PAUSES are a different concept from <Enter>s.
                    // <Enter> (\r) is a commit keystroke; pi-tui treats it
                    // as the boundary at which the current line becomes
                    // a command. A pause is just time, used to let pi-tui
                    // transition internal state between two sends
                    // without committing either one.
                    //
                    // pi-tui requires the trailing SPACE after `/model`
                    // to recognise the command: `/model ` is "command is
                    // recognised, ready for argument". Without the space,
                    // pi-tui sees `/model` followed immediately by the
                    // arg characters, and the command-arg transition
                    // races with the typing of the arg. With the space,
                    // we get a clean discrete "command start" event.
                    //
                    // The 200ms pauses are sequenced as:
                    //   send 1 (sync):   `/model `        start command + arg-input open
                    //   send 2 (+200ms): `<model>`         type arg in arg-input
                    //   send 3 (+200ms): `\r`              commit
                    //
                    // Why this is NOT atomic paste+Enter (commit 29c414a):
                    //   atomic `\x1b[200~/model <n>\x1b[201~\r` bundles
                    //   the trailing \r INSIDE the bracketed paste, which
                    //   pi-tui receives as a single key sequence; the
                    //   command-arg transition never happens because
                    //   pi-tui sees one combined event, not two.
                    //
                    // Why this is NOT picker routing (commit de9562e):
                    //   that form used `/model\r` (commit \r) as a fake
                    //   "open picker" event. pi's picker is a different
                    //   UI; routing through it requires arrows + filter,
                    //   which we don't puppet. The commit \r was
                    //   confused with a "transition \r", which it isn't.
                    //
                    // B is not A: opencode's picker dance is 4 sends
                    // (`/models`, \r, `<model>`, \r) over opencode's
                    // picker. pi's slash command is the same shape
                    // (3 sends, 2 pauses) but goes through pi-tui's
                    // command-arg buffer, not a picker. The pauses
                    // here are pi-tui command-arg transition timing,
                    // they are NOT picker-step timing.
                    this.sendToTab(activeTab, '/model ');
                    setTimeout(() => {
                        this.sendToTab(activeTab, model);
                        setTimeout(() => {
                            this.sendToTab(activeTab, '\r');
                        }, 400);
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

    // applyFontToAllActiveTerminals sets a new fontFamily on every
    // live xterm and re-fits the viewport so layout stays correct.
    // Empty/invalid input falls back to 'JetBrains Mono, monospace'.
    // Deliberately does NOT touch any scroll / _spamScroll timing
    // (see AGENTS.md hard-won-stabilization rule).
    applyFontToAllActiveTerminals(family) {
        const safe = (family && String(family).trim()) || 'JetBrains Mono, monospace';
        for (const tab of this.tabs.values()) {
            if (tab.term) {
                tab.term.options.fontFamily = safe;
                if (tab.fitAddon && typeof tab.fitAddon.fit === 'function') {
                    try { tab.fitAddon.fit(); } catch (e) { /* tolerate closed term */ }
                }
            }
        }
    }

    // applyTerminalFontSizeToAll sets a new fontSize on every live xterm,
    // re-fits, and pushes the resulting geometry to the backend PTY (size
    // changes cols/rows, unlike family). Deliberately does NOT touch any
    // scroll / _spamScroll timing (see AGENTS.md hard-won-stabilization rule).
    applyTerminalFontSizeToAll(size) {
        const isMobile = window.innerWidth <= 768;
        const safe = (size >= 8 && size <= 32) ? size : (isMobile ? 10 : 14);
        for (const tab of this.tabs.values()) {
            if (!tab.term) continue;
            if (tab.term.options.fontSize === safe) continue;
            tab.term.options.fontSize = safe;
            if (tab.fitAddon && typeof tab.fitAddon.fit === 'function') {
                try { tab.fitAddon.fit(); this.sendResizeToBackend(tab); } catch (e) { /* tolerate closed term */ }
            }
        }
    }

    pollTerminalIdleAndNotifications() {
        const isTabVisible = !document.hidden;
        let statusChanged = false;

        for (const tab of this.tabs.values()) {
            if (tab.isDead) continue;

            const isActiveAndVisible = (tab.paneId === this.activePaneId) && isTabVisible;

            // If the tab is currently focused and visible, clear attention states immediately.
            if (isActiveAndVisible && tab.isAttention) {
                tab.isAttention = false;
                tab.tabEl.classList.remove('has-attention');
                statusChanged = true;
            }

            // Track busy-to-idle transition for active terminal connections.
            if (tab.isBusy && tab.lastOutputAt !== undefined) {
                const idleTime = Date.now() - tab.lastOutputAt;
                if (idleTime > 3000) {
                    // Output has stopped for 3 seconds. The PTY transitioned to idle!
                    tab.isBusy = false;
                    statusChanged = true;

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
                        statusChanged = true;
                        tab.tabEl.classList.add('has-attention');

                        // Escalate with notification chimes and browser popups.
                        this.triggerAttentionNotification(tab, promptDetected);
                    }
                }
            }
        }

        // A single render after the scan covers both the ϕ → Φ quiet
        // transition and any completion attention marker without title churn.
        if (statusChanged) this.updateDocumentTitle();
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
                duration: 6000,
                action: {
                    text: 'Go to tab',
                    callback: () => this.switchTab(tab.paneId, { userInitiated: true }),
                },
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
        // Clear the completion/attention layer, then recompose the title.
        // This intentionally preserves ϕ when another tab is still emitting.
        let cleared = false;
        for (const tab of this.tabs.values()) {
            if (tab.isAttention) {
                tab.isAttention = false;
                tab.tabEl.classList.remove('has-attention');
                cleared = true;
            }
        }
        if (cleared) this.updateDocumentTitle();
    }

    // _cyclePromptHistory advances/retreats through the user's previously
    // sent prompts for the active cwd. direction is 'older' (Alt+Up) or
    // 'newer' (Alt+Down). On first call for a cwd, fetches from the
    // server; subsequent calls walk the in-memory cache. Replaces the
    // textarea value and places the cursor at the end.
    //
    // Cursor semantics: -1 = free-form textarea (no entry shown). Any
    // non-negative index is an offset into _historyCache. Pressing Alt+Up
    // from -1 jumps to 0 (newest). Pressing Alt+Up from 0 jumps to 1
    // (older). Pressing Alt+Down decrements; reaching -1 restores the
    // pre-cycle value (saved in _historyPreCycleValue).
    async _cyclePromptHistory(direction) {
        if (!this.inputTextArea) return;

        // Capture the value before any cycle starts so Alt+Down can
        // return to it.
        if (this._historyCursor === -1 && direction === 'newer') {
            return; // already at the "newest" position
        }
        if (this._historyPreCycleValue === undefined && this._historyCursor === -1) {
            this._historyPreCycleValue = this.inputTextArea.value;
        }

        const cwd = (this.app.sessionsManager && this.app.sessionsManager.activeCWD) || '';
        if (cwd !== this._historyCwd || !this._historyLoaded) {
            // Lazy-load the cache for this cwd.
            const ok = await this._loadPromptHistory(cwd);
            if (!ok) return;
        }
        if (this._historyCache.length === 0) {
            return; // nothing to cycle through
        }

        if (direction === 'older') {
            this._historyCursor = Math.min(
                this._historyCursor < 0 ? 0 : this._historyCursor + 1,
                this._historyCache.length - 1,
            );
        } else {
            // 'newer' (Alt+Down)
            if (this._historyCursor <= 0) {
                // Past the newest — restore pre-cycle value.
                this.inputTextArea.value = this._historyPreCycleValue || '';
                this._historyCursor = -1;
                this._historyPreCycleValue = undefined;
                this._placeCursorAtEnd();
                this.adjustInputHeight();
                return;
            }
            this._historyCursor -= 1;
        }

        const entry = this._historyCache[this._historyCursor];
        if (entry) {
            this.inputTextArea.value = entry.text;
            this._placeCursorAtEnd();
            this.adjustInputHeight();
        }
    }

    _placeCursorAtEnd() {
        if (!this.inputTextArea) return;
        const len = this.inputTextArea.value.length;
        this.inputTextArea.setSelectionRange(len, len);
    }

    async _loadPromptHistory(cwd) {
        try {
            const res = await fetch(`/api/prompt-history/recent?cwd=${encodeURIComponent(cwd)}&n=50`);
            if (!res.ok) return false;
            const entries = await res.json();
            if (!Array.isArray(entries)) return false;
            // Server returns newest-first; cache as-is.
            this._historyCache = entries;
            this._historyCwd = cwd;
            this._historyLoaded = true;
            // Do NOT touch _historyCursor / _historyPreCycleValue here:
            // _cyclePromptHistory captures the pre-cycle draft (and
            // reads/advances the cursor) around this call, and this
            // load can run mid-cycle. Clobbering either field here
            // would drop the user's draft on the first Alt+Up.
            return true;
        } catch (err) {
            console.warn('[prompt_history] load failed', err);
            return false;
        }
    }
}
