import { TabManager } from './terminal.js';
import { SessionsManager } from './sessions.js';
import { DiffController } from './diff.js';
import { MarkdownManager } from './markdown.js';
import { KanbanManager } from './kanban.js';

const ACCENT_COLORS = {
    purple: {
        accent: '#7c6af7',
        accentGlow: 'rgba(124, 106, 247, 0.15)',
        accentDim: '#5b4ec2',
        accentBright: '#9a8dfa'
    },
    blue: {
        accent: '#38bdf8',
        accentGlow: 'rgba(56, 189, 248, 0.15)',
        accentDim: '#0284c7',
        accentBright: '#7dd3fc'
    },
    green: {
        accent: '#10b981',
        accentGlow: 'rgba(16, 185, 129, 0.15)',
        accentDim: '#047857',
        accentBright: '#34d399'
    },
    amber: {
        accent: '#fbbf24',
        accentGlow: 'rgba(251, 191, 36, 0.15)',
        accentDim: '#b45309',
        accentBright: '#fcd34d'
    },
    red: {
        accent: '#f87171',
        accentGlow: 'rgba(248, 113, 113, 0.15)',
        accentDim: '#b91c1c',
        accentBright: '#fca5a5'
    },
    pink: {
        accent: '#ec4899',
        accentGlow: 'rgba(236, 72, 153, 0.15)',
        accentDim: '#be185d',
        accentBright: '#f472b6'
    },
    teal: {
        accent: '#14b8a6',
        accentGlow: 'rgba(20, 184, 166, 0.15)',
        accentDim: '#0f766e',
        accentBright: '#5eead4'
    },
    indigo: {
        accent: '#6366f1',
        accentGlow: 'rgba(99, 102, 241, 0.15)',
        accentDim: '#4338ca',
        accentBright: '#818cf8'
    },
    orange: {
        accent: '#f97316',
        accentGlow: 'rgba(249, 115, 22, 0.15)',
        accentDim: '#c2410c',
        accentBright: '#fdba74'
    },
    cyan: {
        accent: '#06b6d4',
        accentGlow: 'rgba(6, 182, 212, 0.15)',
        accentDim: '#0e7490',
        accentBright: '#67e8f9'
    },
    rose: {
        accent: '#f43f5e',
        accentGlow: 'rgba(244, 63, 94, 0.15)',
        accentDim: '#be123c',
        accentBright: '#fb7185'
    },
    lime: {
        accent: '#84cc16',
        accentGlow: 'rgba(132, 204, 22, 0.15)',
        accentDim: '#4d7c0f',
        accentBright: '#a3e635'
    },
    white: {
        accent: '#ffffff',
        accentGlow: 'rgba(255, 255, 255, 0.15)',
        accentDim: '#94a3b8',
        accentBright: '#ffffff'
    },
    gold: {
        accent: '#d4af37',
        accentGlow: 'rgba(212, 175, 55, 0.15)',
        accentDim: '#997a15',
        accentBright: '#f3e5ab'
    },
    violet: {
        accent: '#a78bfa',
        accentGlow: 'rgba(167, 139, 250, 0.15)',
        accentDim: '#6d28d9',
        accentBright: '#ddd6fe'
    },
    emerald: {
        accent: '#059669',
        accentGlow: 'rgba(5, 150, 105, 0.15)',
        accentDim: '#065f46',
        accentBright: '#34d399'
    },
    neon: {
        accent: '#00f0ff',
        accentGlow: 'rgba(0, 240, 255, 0.15)',
        accentDim: '#008b99',
        accentBright: '#70f8ff'
    },
    coral: {
        accent: '#e07a5f',
        accentGlow: 'rgba(224, 122, 95, 0.15)',
        accentDim: '#9e4731',
        accentBright: '#f4a261'
    },
    fuchsia: {
        accent: '#d946ef',
        accentGlow: 'rgba(217, 70, 239, 0.15)',
        accentDim: '#86198f',
        accentBright: '#f0abfc'
    }
};

class App {
    constructor() {
        this.codersPresetRegistry = {};
        this.accentColorSelect = document.getElementById('accent-color-select');
        
        // Instantiate controllers
        this.tabManager = new TabManager(this);
        this.sessionsManager = new SessionsManager(this);
        this.diffController = new DiffController(this);
        this.markdownManager = new MarkdownManager(this);
        this.kanbanManager = new KanbanManager(this);
    }
    
    async init() {
        // 1. Fetch coder templates & presets from API
        await this.fetchCoderPresets();
        
        // 2. Restore previously open terminal tabs (reconnects live PTY sessions)
        await this.tabManager.restoreTabsState();

        // 3. Load workspace selector and configurations
        await this.sessionsManager.loadConfig();

        // 4. Setup panel resize handles
        this.initResizers();

        // 5. Initialize Diff terminal engine
        this.diffController.initTerminal();

        // 6. Setup theme accent listener
        this.accentColorSelect.addEventListener('change', () => {
            const color = this.accentColorSelect.value;
            this.applyAccentTheme(color);
            this.saveTheme(color);
        });

        // 7. Setup mobile sidebar drawer toggle
        const mobileSidebarToggle = document.getElementById('mobile-sidebar-toggle');
        const sidebar = document.getElementById('sidebar-panel');
        if (mobileSidebarToggle && sidebar) {
            mobileSidebarToggle.addEventListener('click', (e) => {
                e.stopPropagation();
                sidebar.classList.toggle('drawer-open');
            });
            
            // Close drawer when clicking outside it
            document.addEventListener('click', (e) => {
                if (sidebar.classList.contains('drawer-open') && !sidebar.contains(e.target) && e.target !== mobileSidebarToggle) {
                    sidebar.classList.remove('drawer-open');
                }
            });
        }

        // 8. Setup header action listeners
        const btopBtn = document.getElementById('header-btop-btn');
        if (btopBtn) {
            btopBtn.addEventListener('click', async () => {
                try {
                    const res = await fetch('/api/terminals', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            coder: 'bash',
                            cwd: this.sessionsManager.activeCWD || this.sessionsManager.activeWorkspace,
                            session_id: '',
                            title: 'btop',
                            workspace: this.sessionsManager.activeWorkspace || ''
                        })
                    });
                    if (!res.ok) throw new Error("Failed to spawn btop session");
                    const data = await res.json();
                    
                    this.tabManager.createTab(data.pane_id, data.session_id, `btop`, 'bash', this.sessionsManager.activeWorkspace, this.sessionsManager.activeCWD);
                    
                    const checkWs = setInterval(() => {
                        const tab = this.tabManager.tabs.get(data.pane_id);
                        if (tab && tab.ws && tab.ws.ws && tab.ws.ws.readyState === WebSocket.OPEN) {
                            clearInterval(checkWs);
                            tab.ws.sendInput('btop\r');
                        }
                    }, 50);
                    setTimeout(() => clearInterval(checkWs), 2000);
                } catch (e) {
                    this.showToast(e.message, { type: 'error' });
                }
            });
        }

        const clipboardBtn = document.getElementById('header-clipboard-btn');
        if (clipboardBtn) {
            clipboardBtn.addEventListener('click', async () => {
                await this.syncRemoteClipboard();
            });
        }

        const exportBtn = document.getElementById('header-export-btn');
        if (exportBtn) {
            exportBtn.addEventListener('click', async () => {
                await this.exportConfig();
            });
        }

        const importBtn = document.getElementById('header-import-btn');
        if (importBtn) {
            importBtn.addEventListener('click', async () => {
                await this.importConfig();
            });
        }

        const kanbanBtn = document.getElementById('header-kanban-btn');
        if (kanbanBtn) {
            kanbanBtn.addEventListener('click', () => {
                this.kanbanManager.openBoard();
            });
        }

        // 9. Setup Mobile Visual Viewport & Keyboard Resizer
        // ==========================================
        // ARCHITECTURAL WARNING TO FUTURE ENGINEERS & LLMs:
        // Do NOT try to solve the iOS WebKit virtual keyboard layout overlay issue using:
        //   - Viewport meta tag `interactive-widget=resizes-content` (completely ignored by iOS Safari).
        //   - `100vh`, `100dvh`, or `100%` height (WebKit layout viewport doesn't resize when the keyboard shows).
        //   - Window `resize` events or `window.innerHeight` (does not trigger/update for virtual keyboard on iOS).
        //   - Shifting the container using `position: absolute` and tracking `visualViewport.offsetTop` (causes horrible layout jumping, latency, and black bar glitches).
        //   - Native document scrolling (WebKit will forcibly scroll the page body to center the focused input, breaking fixed UI layouts).
        //
        // THE ONLY CORRECT WAY (Tested & Proven):
        //   1. Lock html & body on mobile to `position: fixed; overscroll-behavior: none; overflow: hidden;` in CSS.
        //   2. Bind to `window.visualViewport`'s `resize` and `scroll` events.
        //   3. Track `visualViewport.height` and assign it to a CSS custom property (e.g., `--vv-height`) on the root element.
        //   4. Set the main container height to `var(--vv-height)` and pin it with `position: fixed; top: 0; bottom: auto;`.
        //   5. Aggressively intercept scroll events and force `window.scrollTo(0, 0)` to counteract iOS's native scroll-on-focus behaviour.
        // ==========================================
        if (window.visualViewport) {
            const appEl = document.getElementById('app');
            this.updateLayoutPosition = (shouldFit = false) => {
                const isMobile = window.innerWidth <= 768;
                if (isMobile && window.visualViewport) {
                    const viewport = window.visualViewport;
                    
                    // Update the CSS variable for the actual visual viewport height.
                    // This perfectly accounts for the space above the iOS keyboard.
                    document.documentElement.style.setProperty('--vv-height', `${viewport.height}px`);

                    // Reset layout scroll so our fixed container stays exactly pinned.
                    if (window.scrollY > 0 || window.scrollX > 0) {
                        window.scrollTo(0, 0);
                    }

                    if (shouldFit) {
                        this.tabManager?.fitActiveTerminal();
                        this.diffController?.fitTerminal();
                    }
                } else {
                    document.documentElement.style.removeProperty('--vv-height');
                }
            };
            
            // Aggressively prevent iOS from permanently scrolling the layout viewport away from 0,0
            window.addEventListener('scroll', () => {
                if (window.innerWidth <= 768 && (window.scrollY > 0 || window.scrollX > 0)) {
                    window.scrollTo(0, 0);
                }
            }, { passive: true });
            window.visualViewport.addEventListener('resize', () => this.updateLayoutPosition(true));
            window.visualViewport.addEventListener('scroll', () => this.updateLayoutPosition(false));
            
            // Run initially to position correctly
            this.updateLayoutPosition(true);
        }

        // Prevent pinch-to-zoom gestures on mobile viewports
        document.addEventListener('touchstart', (e) => {
            if (e.touches.length > 1) {
                e.preventDefault();
            }
        }, { passive: false });
        
        document.addEventListener('gesturestart', (e) => {
            e.preventDefault();
        }, { passive: false });

        // 10. Swipe Gestures for Drawers on Mobile
        this.setupMobileGestures();
        
        console.log("[app] Phi initialized successfully");
    }

    setupMobileGestures() {
        let touchStartX = 0;
        let touchStartY = 0;
        const sidebar = document.getElementById('sidebar-panel');
        const diffPanel = document.getElementById('diff-panel');
        const threshold = 60; // minimum distance in px to register a swipe
        
        document.addEventListener('touchstart', (e) => {
            if (window.innerWidth > 768) return;
            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
        }, { passive: true });

        document.addEventListener('touchend', (e) => {
            if (window.innerWidth > 768) return;
            const touchEndX = e.changedTouches[0].clientX;
            const touchEndY = e.changedTouches[0].clientY;
            
            const diffX = touchEndX - touchStartX;
            const diffY = touchEndY - touchStartY;
            
            if (Math.abs(diffX) > Math.abs(diffY) && Math.abs(diffX) > threshold) {
                if (diffX > 0) {
                    // Swipe Right
                    if (touchStartX < 40) {
                        // Swipe from left edge -> Open Sidebar Drawer
                        sidebar?.classList.add('drawer-open');
                    } else if (diffPanel && !diffPanel.classList.contains('hidden')) {
                        // Swipe right inside panel -> Close Diff Drawer
                        this.diffController?.togglePanel(false);
                    }
                } else {
                    // Swipe Left
                    if (window.innerWidth - touchStartX < 40) {
                        // Swipe from right edge -> Open Diff Drawer
                        this.diffController?.togglePanel(true);
                    } else if (sidebar?.classList.contains('drawer-open')) {
                        // Swipe left inside sidebar -> Close Sidebar Drawer
                        sidebar.classList.remove('drawer-open');
                    }
                }
            }
        }, { passive: true });
    }
    
    async fetchCoderPresets() {
        try {
            const res = await fetch('/api/coders');
            this.codersPresetRegistry = await res.json();
            console.log("[app] Loaded coder registries:", this.codersPresetRegistry);
        } catch (e) {
            console.error("[app] Failed to fetch coder presets:", e);
        }
    }
    
    initResizers() {
        const leftHandle = document.getElementById('left-resize-handle');
        const rightHandle = document.getElementById('right-resize-handle');
        const sidebar = document.getElementById('sidebar-panel');
        const diffPanel = document.getElementById('diff-panel');
        const layout = document.querySelector('.main-layout');

        // Load saved sizes from localStorage
        const savedLeftWidth = localStorage.getItem('phi_panel_left_width');
        const savedRightWidth = localStorage.getItem('phi_panel_right_width');
        if (savedLeftWidth) {
            sidebar.style.width = savedLeftWidth + 'px';
            const widthNum = parseFloat(savedLeftWidth);
            if (widthNum < 120) {
                sidebar.classList.add('sidebar-narrow');
            } else {
                sidebar.classList.remove('sidebar-narrow');
            }
        }
        if (savedRightWidth) diffPanel.style.width = savedRightWidth + 'px';

        // Left resizing handler
        leftHandle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            leftHandle.classList.add('dragging');
            document.body.style.cursor = 'col-resize';
            this.tabManager.startResize(); // Start layout resize tracking

            const doDrag = (moveEvent) => {
                const width = moveEvent.clientX - layout.getBoundingClientRect().left;
                if (width > 60 && width < 450) {
                    sidebar.style.width = width + 'px';
                    localStorage.setItem('phi_panel_left_width', width);
                    
                    if (width < 120) {
                        sidebar.classList.add('sidebar-narrow');
                    } else {
                        sidebar.classList.remove('sidebar-narrow');
                    }
                    
                    this.tabManager.fitActiveTerminal();
                }
            };

            const stopDrag = () => {
                leftHandle.classList.remove('dragging');
                document.body.style.cursor = '';
                document.removeEventListener('mousemove', doDrag);
                document.removeEventListener('mouseup', stopDrag);
                this.tabManager.fitActiveTerminal();
                this.tabManager.endResize(); // End layout resize tracking
            };

            document.addEventListener('mousemove', doDrag);
            document.addEventListener('mouseup', stopDrag);
        });

        // Right resizing handler
        rightHandle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            rightHandle.classList.add('dragging');
            document.body.style.cursor = 'col-resize';
            this.tabManager.startResize(); // Start layout resize tracking

            const doDrag = (moveEvent) => {
                const width = layout.getBoundingClientRect().right - moveEvent.clientX;
                if (width > 200 && width < 600) {
                    diffPanel.style.width = width + 'px';
                    localStorage.setItem('phi_panel_right_width', width);
                    this.tabManager.fitActiveTerminal();
                    this.diffController.fitTerminal();
                }
            };

            const stopDrag = () => {
                rightHandle.classList.remove('dragging');
                document.body.style.cursor = '';
                document.removeEventListener('mousemove', doDrag);
                document.removeEventListener('mouseup', stopDrag);
                this.tabManager.fitActiveTerminal();
                this.diffController.fitTerminal();
                this.tabManager.endResize(); // End layout resize tracking
            };

            document.addEventListener('mousemove', doDrag);
            document.addEventListener('mouseup', stopDrag);
        });
    }

    applyAccentTheme(colorKey) {
        const theme = ACCENT_COLORS[colorKey] || ACCENT_COLORS.purple;
        document.documentElement.style.setProperty('--accent', theme.accent);
        document.documentElement.style.setProperty('--accent-glow', theme.accentGlow);
        document.documentElement.style.setProperty('--accent-dim', theme.accentDim);
        document.documentElement.style.setProperty('--accent-bright', theme.accentBright);
        
        if (this.tabManager) {
            this.tabManager.applyThemeToAllActiveTerminals(theme.accent);
        }

        // Dynamically update SVG favicon to match the selected theme
        this.updateFavicon(theme.accent, theme.accentDim);
    }

    updateFavicon(accent, accentDim) {
        // Remove all existing icon links to force Safari to clear its cache hook for the node
        const links = document.querySelectorAll("link[rel~='icon']");
        links.forEach(l => l.remove());
        
        const link = document.createElement('link');
        link.rel = 'icon';
        link.type = 'image/svg+xml';
        
        const svg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <defs>
    <radialGradient id="glow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${accent}" />
      <stop offset="100%" stop-color="${accentDim}" />
    </radialGradient>
  </defs>
  <rect width="32" height="32" rx="8" fill="url(#glow)"/>
  <text x="50%" y="60%" font-family="system-ui, -apple-system, sans-serif" font-size="20" font-weight="bold" fill="#ffffff" text-anchor="middle">Φ</text>
</svg>
        `.trim();
        
        link.href = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
        document.getElementsByTagName('head')[0].appendChild(link);
    }

    async saveTheme(colorKey) {
        try {
            await fetch('/api/config/theme', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ color: colorKey })
            });
        } catch (e) {
            console.error("[theme] Failed to save theme:", e);
        }
    }

    /**
     * Show a transient toast notification in the top-right corner.
     * @param {string} message - body text (the precise error/info)
     * @param {object} [opts]
     * @param {'error'|'info'} [opts.type='info']
     * @param {string} [opts.title] - bold heading; defaults based on type
     * @param {number} [opts.duration=6000] - ms before auto-dismiss; 0 to persist
     */
    showToast(message, opts = {}) {
        const { type = 'info', duration = 6000 } = opts;
        const title = opts.title || (type === 'error' ? "Couldn't open session" : 'Notice');

        let container = document.getElementById('toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'toast-container';
            container.className = 'toast-container';
            document.body.appendChild(container);
        }

        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;

        const icon = document.createElement('span');
        icon.className = 'toast-icon';
        icon.textContent = type === 'error' ? '⚠' : 'ℹ';

        const body = document.createElement('div');
        body.className = 'toast-body';
        const titleEl = document.createElement('div');
        titleEl.className = 'toast-title';
        titleEl.textContent = title;
        const msgEl = document.createElement('div');
        msgEl.className = 'toast-message';
        msgEl.textContent = message;
        body.appendChild(titleEl);
        body.appendChild(msgEl);

        let dismissTimer;
        const dismiss = () => {
            if (dismissTimer) clearTimeout(dismissTimer);
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 200);
        };

        if (opts.action) {
            const actionBtn = document.createElement('button');
            actionBtn.className = 'toast-action-btn';
            actionBtn.textContent = opts.action.text;
            actionBtn.style.marginTop = '6px';
            actionBtn.style.padding = '3px 8px';
            actionBtn.style.backgroundColor = 'var(--accent, #7c6af7)';
            actionBtn.style.color = '#ffffff';
            actionBtn.style.border = 'none';
            actionBtn.style.borderRadius = '4px';
            actionBtn.style.cursor = 'pointer';
            actionBtn.style.fontSize = '12px';
            actionBtn.style.fontWeight = 'bold';
            actionBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                opts.action.callback();
                dismiss();
            });
            body.appendChild(actionBtn);
        }

        const closeBtn = document.createElement('button');
        closeBtn.className = 'toast-close';
        closeBtn.innerHTML = '×';
        closeBtn.title = 'Dismiss';

        toast.appendChild(icon);
        toast.appendChild(body);
        toast.appendChild(closeBtn);
        container.appendChild(toast);

        // Animate in on next frame
        requestAnimationFrame(() => toast.classList.add('show'));

        closeBtn.addEventListener('click', dismiss);
        if (duration > 0) {
            dismissTimer = setTimeout(dismiss, duration);
        }

        return dismiss;
    }

    async syncRemoteClipboard() {
        const btn = document.getElementById('header-clipboard-btn');
        try {
            if (btn) btn.classList.add('loading');
            // Pass the active pane ID so the server can read from THAT PTY's
            // session-isolated clipboard shim rather than the global shim
            // (which gets overwritten every time a new PTY is created and
            // produces "synced but blank newline" over remote/headless
            // sessions). Fall back to no ?pane= if there's no active tab.
            let url = '/api/clipboard';
            const activeTab = this.tabManager && this.tabManager.getActiveTab();
            if (activeTab && activeTab.paneId) {
                url += '?pane=' + encodeURIComponent(activeTab.paneId);
            }
            const res = await fetch(url);
            if (!res.ok) throw new Error("Failed to fetch remote clipboard");
            const data = await res.json();
            const text = (data && typeof data.text === 'string') ? data.text : '';
            const empty = data && data.empty === true;

            if (!empty && text.length > 0) {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    await navigator.clipboard.writeText(text);
                } else {
                    // Fallback to classic execCommand method for insecure contexts (e.g. remoting via local HTTP IP address)
                    const textArea = document.createElement("textarea");
                    textArea.value = text;
                    textArea.style.position = "fixed";
                    textArea.style.top = "0";
                    textArea.style.left = "0";
                    textArea.style.opacity = "0";
                    document.body.appendChild(textArea);
                    textArea.focus();
                    textArea.select();
                    try {
                        const success = document.execCommand("copy");
                        if (!success) throw new Error("execCommand copy returned false");
                    } finally {
                        document.body.removeChild(textArea);
                    }
                }
                console.log("[clipboard] Synced from", data.source || "?", "len=", text.length);

                if (btn) {
                    btn.classList.add('success');
                    const span = btn.querySelector('span');
                    const origText = span.innerText;
                    span.innerText = "Synced!";
                    setTimeout(() => {
                        btn.classList.remove('success');
                        span.innerText = origText;
                    }, 1500);
                }
            } else {
                // Honest empty path. Don't claim success, don't write empty
                // string to the local clipboard (which was the bug — a
                // successful write of "" showed "Synced!" but cleared the
                // user's local clipboard).
                console.log("[clipboard] nothing to sync (source=", data.source || "?", ")");
                this.showToast(
                    data.source === 'shim'
                        ? 'Active session clipboard is empty'
                        : 'Remote clipboard is empty',
                    { type: 'info', title: 'Clipboard' }
                );
                if (btn) {
                    btn.classList.add('error');
                    const span = btn.querySelector('span');
                    const origText = span.innerText;
                    span.innerText = "Empty";
                    setTimeout(() => {
                        btn.classList.remove('error');
                        span.innerText = origText;
                    }, 1500);
                }
            }
        } catch (e) {
            console.error("[clipboard] Sync error:", e);
            if (btn) {
                btn.classList.add('error');
                const span = btn.querySelector('span');
                const origText = span.innerText;
                span.innerText = "Failed!";
                setTimeout(() => {
                    btn.classList.remove('error');
                    span.innerText = origText;
                }, 1500);
            }
        } finally {
            if (btn) btn.classList.remove('loading');
        }
    }

    async _doExportConfig(url, btnElement) {
        try {
            if (btnElement) btnElement.classList.add('loading');
            const res = await fetch(url);
            if (!res.ok) throw new Error("Failed to export config");
            const data = await res.json();
            
            if (data.config) {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    await navigator.clipboard.writeText(data.config);
                } else {
                    const textArea = document.createElement("textarea");
                    textArea.value = data.config;
                    textArea.style.position = "fixed";
                    textArea.style.top = "0";
                    textArea.style.left = "0";
                    textArea.style.opacity = "0";
                    document.body.appendChild(textArea);
                    textArea.focus();
                    textArea.select();
                    try {
                        const success = document.execCommand("copy");
                        if (!success) throw new Error("execCommand copy failed");
                    } finally {
                        document.body.removeChild(textArea);
                    }
                }
                
                if (btnElement) {
                    btnElement.classList.add('success');
                    const span = btnElement.querySelector('span') || btnElement;
                    const origText = span.innerText || span.textContent;
                    if (span.innerText !== undefined) {
                        span.innerText = "Copied!";
                    } else {
                        span.textContent = "Copied!";
                    }
                    setTimeout(() => {
                        btnElement.classList.remove('success');
                        if (span.innerText !== undefined) {
                            span.innerText = origText;
                        } else {
                            span.textContent = origText;
                        }
                    }, 1500);
                }
            }
        } catch (e) {
            console.error("[config] Export error:", e);
            if (btnElement) {
                btnElement.classList.add('error');
                const span = btnElement.querySelector('span') || btnElement;
                const origText = span.innerText || span.textContent;
                if (span.innerText !== undefined) {
                    span.innerText = "Failed!";
                } else {
                    span.textContent = "Failed!";
                }
                setTimeout(() => {
                    btnElement.classList.remove('error');
                    if (span.innerText !== undefined) {
                        span.innerText = origText;
                    } else {
                        span.textContent = origText;
                    }
                }, 1500);
            }
        } finally {
            if (btnElement) btnElement.classList.remove('loading');
        }
    }

    async _doImportConfig(url, btnElement, prefix, onCompleted) {
        try {
            if (btnElement) btnElement.classList.add('loading');
            
            let configText = "";
            if (navigator.clipboard && navigator.clipboard.readText) {
                try {
                    configText = await navigator.clipboard.readText();
                } catch (e) {
                    console.warn("[config] Browser blocked clipboard read, falling back to prompt", e);
                    configText = prompt(`Paste your config string here (starts with ${prefix}:):`);
                }
            } else {
                configText = prompt(`Paste your config string here (starts with ${prefix}:):`);
            }
            
            if (!configText) {
                if (btnElement) btnElement.classList.remove('loading');
                return; // User cancelled or pasted empty string
            }
            
            configText = configText.trim();
            if (!configText.startsWith(`${prefix}:`)) {
                throw new Error(`Invalid format. Config must start with ${prefix}:`);
            }
            
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ config: configText })
            });
            
            if (!res.ok) {
                const text = await res.text();
                throw new Error(text || "Failed to import config");
            }
            
            if (btnElement) {
                btnElement.classList.add('success');
                const span = btnElement.querySelector('span') || btnElement;
                const origText = span.innerText || span.textContent;
                if (span.innerText !== undefined) {
                    span.innerText = "Imported!";
                } else {
                    span.textContent = "Imported!";
                }
                setTimeout(() => {
                    btnElement.classList.remove('success');
                    if (span.innerText !== undefined) {
                        span.innerText = origText;
                    } else {
                        span.textContent = origText;
                    }
                    if (onCompleted) {
                        onCompleted();
                    }
                }, 1500);
            } else {
                if (onCompleted) {
                    onCompleted();
                }
            }
        } catch (e) {
            console.error("[config] Import error:", e);
            if (btnElement) {
                btnElement.classList.add('error');
                const span = btnElement.querySelector('span') || btnElement;
                const origText = span.innerText || span.textContent;
                if (span.innerText !== undefined) {
                    span.innerText = "Failed!";
                } else {
                    span.textContent = "Failed!";
                }
                alert("Import failed: " + e.message);
                setTimeout(() => {
                    btnElement.classList.remove('error');
                    if (span.innerText !== undefined) {
                        span.innerText = origText;
                    } else {
                        span.textContent = origText;
                    }
                }, 1500);
            }
        } finally {
            if (btnElement) btnElement.classList.remove('loading');
        }
    }

    async exportConfig() {
        await this._doExportConfig('/api/config/export', document.getElementById('header-export-btn'));
    }

    async importConfig() {
        await this._doImportConfig('/api/config/import', document.getElementById('header-import-btn'), "PHICONFIG", () => {
            location.reload(); // Reload to apply import changes
        });
    }

    async exportModelsConfig(btnElement) {
        await this._doExportConfig('/api/config/export-models', btnElement);
    }

    async importModelsConfig(btnElement) {
        await this._doImportConfig('/api/config/import-models', btnElement, "PHIMODELS", async () => {
            await this.sessionsManager.loadConfig();
        });
    }
}

// Start Application on DOM Load
window.addEventListener('DOMContentLoaded', () => {
    const app = new App();
    app.init();
});
