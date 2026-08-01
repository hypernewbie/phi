import { TabManager } from './terminal.js';
import { SessionsManager } from './sessions.js';
import { DiffController } from './diff.js';
import { MarkdownManager } from './markdown.js';
import { FileTreeManager } from './filetree.js';
import { KanbanManager } from './kanban.js';
import { escapeHtml, buildPhiFaviconSvg } from './util.js';
import { SyncManager } from './sync.js';
import { bootstrapAccessAuth, clearAccessPassword, setAccessPassword } from './auth.js';

// NOTE: When adding a new theme color, you must update:
// 1. web/app.js: Add properties in ACCENT_COLORS
// 2. web/index.html: Add <option> in #accent-color-select
// 3. main.go: Add entry in printWelcomeBanner colors map
// 4. bonus/: Add matching theme profiles to bonus/vim_themes/, bonus/pi_themes/, bonus/opencode_themes/, and bonus/btop_themes/
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
    },
    // Bonus themes — must match the names in bonus/{btop,opencode,pi,vim}_themes/.
    // If you add a bonus theme, add it here too. If you add it here without
    // a bonus counterpart, it'll diverge from the bonus theme profile set.
    canary: {
        accent: '#ffee10',
        accentGlow: 'rgba(255, 238, 16, 0.18)',
        accentDim: '#b8ad00',
        accentBright: '#ffff66'
    },
    copper: {
        accent: '#d35400',
        accentGlow: 'rgba(211, 84, 0, 0.18)',
        accentDim: '#8a3700',
        accentBright: '#e59866'
    },
    mint: {
        accent: '#2ed573',
        accentGlow: 'rgba(46, 213, 115, 0.18)',
        accentDim: '#1a8a4a',
        accentBright: '#7bed9f'
    }
};

export class App {
    constructor() {
        this.codersPresetRegistry = {};
        // Browser chrome state is independent from the in-app CPU logo state.
        // The TabManager toggles this only when live PTY output starts/stops.
        this.terminalActivity = false;
        this.faviconAccent = null;
        this.faviconAccentDim = null;
        // Appearance settings (ingested from /api/config on boot, mutated
        // by the Settings modal, persisted to /api/config/appearance).
        this.uiFontFamily = '';
        this.uiFontSize = 0;
        this.terminalFontFamily = '';
        this.terminalFontSize = 0;
        this.customFontName = '';
        this.accessAuthEnabled = false;

        // Instantiate controllers
        this.tabManager = new TabManager(this);
        this.sessionsManager = new SessionsManager(this);
        this.diffController = new DiffController(this);
        this.markdownManager = new MarkdownManager(this);
        this.fileTreeManager = new FileTreeManager(this);
        this.kanbanManager = new KanbanManager(this);
        this.syncManager = new SyncManager(this);
    }
    
    async init() {
        // 0. Load version details
        await this.loadVersion();

        // 1. Fetch coder templates & presets from API
        await this.fetchCoderPresets();

        // 2. Restore previously open terminal tabs (reconnects live PTY sessions)
        await this.tabManager.restoreTabsState();

        // 3. Load workspace selector and configurations
        await this.sessionsManager.loadConfig();

        // 4. Setup panel resize handles
        this.initResizers();

        // 4.5 Wire up global keyboard shortcuts (Ctrl+Shift+D = diag panel).
        this.initGlobalShortcuts();

        // 5. Initialize Diff terminal engine
        this.diffController.initTerminal();

        // 6. Wire up the Settings modal trigger (the entire config pill
        // is clickable, not just the label — see #header-config-pill).
        const settingsTrigger = document.getElementById('header-config-pill');
        if (settingsTrigger) {
            settingsTrigger.addEventListener('click', (e) => {
                // Don't open settings if the user clicked one of the
                // export/import sub-buttons (they have their own handlers).
                if (e.target.closest('.pill-btn')) return;
                this.openSettingsModal();
            });
        }

        // 6.5 Start fleet poller (plan §3.4). Polls every 15s while the
        // sidebar is visible. Renders peer rows; hides panel when no
        // peers configured. Cheap, no-ops when no fleet config.
        this.startFleetPolling();

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

        document.querySelectorAll('#empty-state .empty-launch-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const coder = btn.dataset.coder;
                if (coder) {
                    this.sessionsManager.switchCoder(coder);
                    this.sessionsManager.spawnNewSession();
                }
            });
        });

        const ntfyBtn = document.getElementById('header-ntfy-btn');
        const pushoverModal = document.getElementById('pushover-modal');
        const pushoverClose = document.getElementById('pushover-modal-close');

        const simplepushToggle = document.getElementById('simplepush-enabled-toggle');
        const simplepushKeyInput = document.getElementById('simplepush-key-input');
        const simplepushSaveBtn = document.getElementById('simplepush-save-btn');
        const simplepushTestBtn = document.getElementById('simplepush-test-btn');

        const pushoverToggle = document.getElementById('pushover-enabled-toggle');
        const pushoverUserKeyInput = document.getElementById('pushover-user-key-input');
        const pushoverAppTokenInput = document.getElementById('pushover-app-token-input');
        const pushoverSaveBtn = document.getElementById('pushover-save-btn');
        const pushoverTestBtn = document.getElementById('pushover-test-btn');

        const webhookToggle = document.getElementById('webhook-enabled-toggle');
        const webhookUrlInput = document.getElementById('webhook-url-input');
        const webhookSaveBtn = document.getElementById('webhook-save-btn');
        const webhookTestBtn = document.getElementById('webhook-test-btn');

        if (ntfyBtn && pushoverModal) {
            ntfyBtn.addEventListener('click', async () => {
                try {
                    const [resS, resP, resW] = await Promise.all([
                        fetch('/api/config/simplepush'),
                        fetch('/api/config/pushover'),
                        fetch('/api/config/webhook')
                    ]);
                    if (resS.ok) {
                        const dataS = await resS.json();
                        if (simplepushKeyInput) simplepushKeyInput.value = dataS.simplepush_key || '';
                        if (simplepushToggle) simplepushToggle.checked = !!dataS.simplepush_enabled;
                    }
                    if (resP.ok) {
                        const dataP = await resP.json();
                        if (pushoverUserKeyInput) pushoverUserKeyInput.value = dataP.pushover_user_key || '';
                        if (pushoverAppTokenInput) pushoverAppTokenInput.value = dataP.pushover_app_token || '';
                        if (pushoverToggle) pushoverToggle.checked = !!dataP.pushover_enabled;
                    }
                    if (resW.ok) {
                        const dataW = await resW.json();
                        if (webhookUrlInput) webhookUrlInput.value = dataW.webhook_url || '';
                        if (webhookToggle) webhookToggle.checked = !!dataW.webhook_enabled;
                    }
                } catch (e) {
                    console.error("Failed to fetch notification config:", e);
                }
                pushoverModal.classList.remove('hidden');
            });

            pushoverClose?.addEventListener('click', () => {
                pushoverModal.classList.add('hidden');
            });
            // Escape closes the pushover modal — matches the pattern in
            // markdown.js (md-modal), app.js (ws-modal), diff.js (diff-modal).
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && !pushoverModal.classList.contains('hidden')) {
                    pushoverModal.classList.add('hidden');
                }
            });

            const saveSimplepushConfig = async () => {
                try {
                    await fetch('/api/config/simplepush', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            simplepush_key: simplepushKeyInput?.value.trim() || '',
                            simplepush_enabled: !!simplepushToggle?.checked
                        })
                    });
                } catch (e) {
                    console.error("Failed to save simplepush config:", e);
                }
            };

            const savePushoverConfig = async () => {
                try {
                    await fetch('/api/config/pushover', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            pushover_user_key: pushoverUserKeyInput?.value.trim() || '',
                            pushover_app_token: pushoverAppTokenInput?.value.trim() || '',
                            pushover_enabled: !!pushoverToggle?.checked
                        })
                    });
                } catch (e) {
                    console.error("Failed to save pushover config:", e);
                }
            };

            const saveWebhookConfig = async () => {
                try {
                    await fetch('/api/config/webhook', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            webhook_url: webhookUrlInput?.value.trim() || '',
                            webhook_enabled: !!webhookToggle?.checked
                        })
                    });
                } catch (e) {
                    console.error("Failed to save webhook config:", e);
                }
            };

            simplepushToggle?.addEventListener('change', saveSimplepushConfig);
            simplepushSaveBtn?.addEventListener('click', async () => {
                await saveSimplepushConfig();
                const origText = simplepushSaveBtn.textContent;
                simplepushSaveBtn.textContent = 'Saved ✓';
                setTimeout(() => { simplepushSaveBtn.textContent = origText; }, 1500);
            });

            pushoverToggle?.addEventListener('change', savePushoverConfig);
            pushoverSaveBtn?.addEventListener('click', async () => {
                await savePushoverConfig();
                const origText = pushoverSaveBtn.textContent;
                pushoverSaveBtn.textContent = 'Saved ✓';
                setTimeout(() => { pushoverSaveBtn.textContent = origText; }, 1500);
            });

            webhookToggle?.addEventListener('change', saveWebhookConfig);
            webhookSaveBtn?.addEventListener('click', async () => {
                await saveWebhookConfig();
                const origText = webhookSaveBtn.textContent;
                webhookSaveBtn.textContent = 'Saved ✓';
                setTimeout(() => { webhookSaveBtn.textContent = origText; }, 1500);
            });

            simplepushTestBtn?.addEventListener('click', async () => {
                await saveSimplepushConfig();
                const origText = simplepushTestBtn.textContent;
                simplepushTestBtn.disabled = true;
                simplepushTestBtn.textContent = 'Sending...';
                try {
                    const res = await fetch('/api/config/simplepush/test', { method: 'POST' });
                    if (!res.ok) {
                        const err = await res.text();
                        alert(`Test Simplepush failed: ${err}`);
                    } else {
                        simplepushTestBtn.textContent = 'Sent ✓';
                        setTimeout(() => { simplepushTestBtn.textContent = origText; simplepushTestBtn.disabled = false; }, 2000);
                        return;
                    }
                } catch (e) {
                    alert(`Test Simplepush error: ${e.message}`);
                }
                simplepushTestBtn.textContent = origText;
                simplepushTestBtn.disabled = false;
            });

            pushoverTestBtn?.addEventListener('click', async () => {
                await savePushoverConfig();
                const origText = pushoverTestBtn.textContent;
                pushoverTestBtn.disabled = true;
                pushoverTestBtn.textContent = 'Sending...';
                try {
                    const res = await fetch('/api/config/pushover/test', { method: 'POST' });
                    if (!res.ok) {
                        const err = await res.text();
                        alert(`Test notification failed: ${err}`);
                    } else {
                        pushoverTestBtn.textContent = 'Sent ✓';
                        setTimeout(() => { pushoverTestBtn.textContent = origText; pushoverTestBtn.disabled = false; }, 2000);
                        return;
                    }
                } catch (e) {
                    alert(`Test notification error: ${e.message}`);
                }
                pushoverTestBtn.textContent = origText;
                pushoverTestBtn.disabled = false;
            });

            webhookTestBtn?.addEventListener('click', async () => {
                await saveWebhookConfig();
                const origText = webhookTestBtn.textContent;
                webhookTestBtn.disabled = true;
                webhookTestBtn.textContent = 'Sending...';
                try {
                    const res = await fetch('/api/config/webhook/test', { method: 'POST' });
                    if (!res.ok) {
                        const err = await res.text();
                        alert(`Test webhook failed: ${err}`);
                    } else {
                        webhookTestBtn.textContent = 'Sent ✓';
                        setTimeout(() => { webhookTestBtn.textContent = origText; webhookTestBtn.disabled = false; }, 2000);
                        return;
                    }
                } catch (e) {
                    alert(`Test webhook error: ${e.message}`);
                }
                webhookTestBtn.textContent = origText;
                webhookTestBtn.disabled = false;
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
        //   5. Correct document scroll only from the input-focus path that
        //      triggered iOS's native focus-scroll — never from generic scroll events.
        // ==========================================
        if (window.visualViewport) {
            const appEl = document.getElementById('app');
            this.updateLayoutPosition = (shouldFit = false, resetDocumentScroll = false) => {
                const isMobile = window.innerWidth <= 768;
                if (isMobile && window.visualViewport) {
                    const viewport = window.visualViewport;
                    
                    // Update the CSS variable for the actual visual viewport height.
                    // This perfectly accounts for the space above the iOS keyboard.
                    document.documentElement.style.setProperty('--vv-height', `${viewport.height}px`);

                    // iOS may move the document to reveal a focused input.
                    // Correct that specific focus side effect only; doing this
                    // for every scroll event steals terminal/page scrolling.
                    if (resetDocumentScroll && (window.scrollY > 0 || window.scrollX > 0)) {
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
            
            // Keyboard geometry changes are layout events, so they may
            // correct iOS focus-scroll; visualViewport scroll remains a user
            // gesture and must never reset the document origin.
            window.visualViewport.addEventListener('resize', () => this.updateLayoutPosition(true, true));
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
    
    initGlobalShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Ctrl+Shift+D = diag panel. Matches the existing Ctrl+Shift+F
            // search and Ctrl+P pattern (terminal.js handles terminal ones).
            if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
                e.preventDefault();
                if (this.markdownManager && typeof this.markdownManager.openDiagModal === 'function') {
                    this.markdownManager.openDiagModal();
                }
            }
        });
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
        document.documentElement.setAttribute('data-theme-color', colorKey);
        localStorage.setItem('phi_theme_color', colorKey);

        if (this.tabManager) {
            this.tabManager.applyThemeToAllActiveTerminals(theme.accent);
        }

        // Dynamically update SVG favicon to match the selected theme.
        this.updateFavicon(theme.accent, theme.accentDim);
    }

    // Browser chrome's live-output state is intentionally separate from the
    // in-app Phi logo, which already visualizes CPU load. Re-render only on a
    // quiet ↔ output transition; never animate or churn the tab favicon.
    setTerminalActivity(hasActivity) {
        const next = Boolean(hasActivity);
        if (this.terminalActivity === next) return;
        this.terminalActivity = next;
        this.updateFavicon();
    }

    updateFavicon(accent, accentDim) {
        // Theme application supplies explicit colors; an early terminal write
        // can arrive before config does, in which case CSS already has the
        // boot-time palette from index.html.
        if (accent) this.faviconAccent = accent;
        if (accentDim) this.faviconAccentDim = accentDim;
        const styles = getComputedStyle(document.documentElement);
        const faviconAccent = this.faviconAccent || styles.getPropertyValue('--accent').trim();
        const faviconAccentDim = this.faviconAccentDim || styles.getPropertyValue('--accent-dim').trim();

        // Remove all existing icon links to force Safari to clear its cache hook for the node.
        const links = document.querySelectorAll("link[rel~='icon']");
        links.forEach(l => l.remove());
        
        const link = document.createElement('link');
        link.rel = 'icon';
        link.type = 'image/svg+xml';
        
        const svg = buildPhiFaviconSvg(faviconAccent, faviconAccentDim, this.terminalActivity);
        
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

    // openSettingsModal renders the appearance + behavior + about modal.
    // Settings are live-applied (no Save button) — see architect notes.
    // The accent swatch grid is the source of truth for theme color
    // selection; the previous #accent-color-select has been removed.
    openSettingsModal() {
        // Re-use guard so a duplicate click doesn't stack overlays.
        if (document.querySelector('.settings-overlay')) return;

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay settings-overlay hidden';

        const modal = document.createElement('div');
        modal.className = 'modal-content settings-modal';

        // ── Header: Φ logo + title + version ─────────────────────
        const header = document.createElement('div');
        header.className = 'modal-header settings-header';

        const identity = document.createElement('div');
        identity.className = 'settings-identity';

        const logo = document.createElement('div');
        logo.className = 'settings-logo';
        logo.textContent = '\u03A6'; // Φ
        identity.appendChild(logo);

        const idText = document.createElement('div');
        const titleEl = document.createElement('h3');
        titleEl.textContent = 'Phi';
        const verEl = document.createElement('div');
        verEl.className = 'settings-version';
        const v = this.versionInfo || {};
        const short = (v.commit || '').slice(0, 7);
        verEl.textContent = v.version
            ? `v${v.version}${short ? ' · ' + short : ''}`
            : 'v?';
        verEl.title = [v.date, v.buildSource].filter(Boolean).join(' · ') || 'unknown build';
        idText.appendChild(titleEl);
        idText.appendChild(verEl);
        identity.appendChild(idText);
        header.appendChild(identity);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'modal-close-btn';
        closeBtn.type = 'button';
        closeBtn.textContent = '\u00d7'; // ×
        closeBtn.title = 'Close';
        header.appendChild(closeBtn);

        // ── Body ─────────────────────────────────────────────────
        const body = document.createElement('div');
        body.className = 'modal-body settings-body';

        // Appearance group ──────────────────────────────────────
        const appGroup = this._buildSettingsGroup('Appearance');
        body.appendChild(appGroup);

        // Highlight color: 22-swatch grid (replaces #accent-color-select).
        const activeColor = document.documentElement.getAttribute('data-theme-color') || 'purple';
        const swatchRow = this._buildSwatchRow(activeColor);
        appGroup.appendChild(swatchRow);

        // UI font family
        const uiFontOptions = [
            { value: '', label: 'System default' },
            { value: 'Inter, system-ui, sans-serif', label: 'Inter' },
            { value: 'system-ui, -apple-system, sans-serif', label: 'System UI' },
            { value: '"Segoe UI", system-ui, sans-serif', label: 'Segoe UI' },
            { value: '"Helvetica Neue", Arial, sans-serif', label: 'Helvetica Neue' },
            { value: 'ui-monospace, "Cascadia Code", "Source Code Pro", monospace', label: 'Mono / dev-style' },
        ];
        // Custom uploaded font (Milestone 4): expose if active.
        if (this.customFontName) {
            uiFontOptions.push({ value: 'Phi Custom Font', label: `Custom: ${this.customFontName}` });
        }
        const uiFontRow = this._buildSelectRow('UI font', 'settings-ui-font', uiFontOptions, this.uiFontFamily);
        appGroup.appendChild(uiFontRow);

        // UI font size
        const uiSizeRow = this._buildNumberRow('UI font size', 'settings-ui-font-size', this.uiFontSize || 14, 10, 24);
        appGroup.appendChild(uiSizeRow);

        // Terminal font family — curated dropdown (mirrors the UI font
        // control). Nerd Font entries render glyphs only if that font is
        // installed on the machine running the browser (xterm.js renders
        // client-side; we do not bundle fonts) — otherwise the fallback
        // chain still yields readable text without icons. Mono variants
        // come first in every Nerd Font chain since xterm assumes fixed
        // cell width, keeping Powerline glyphs single-cell.
        const termFontOptions = [
            { value: '',                                            label: 'Default (JetBrains Mono)' },
            { value: "'Fira Code', ui-monospace, monospace",        label: 'Fira Code' },
            { value: "'Cascadia Code', ui-monospace, monospace",    label: 'Cascadia Code' },
            { value: "ui-monospace, 'SF Mono', Menlo, monospace",   label: 'SF Mono / Menlo' },
            { value: "Consolas, 'Cascadia Mono', monospace",        label: 'Consolas' },
            { value: "'Source Code Pro', ui-monospace, monospace",  label: 'Source Code Pro' },
            // ── Nerd Fonts (mono variants) — for starship / powerline glyphs. ──
            // Each chain: Nerd Font Mono (single-cell glyphs) → Nerd Font → base font
            // (Google-Fonts/system, readable text w/o icons) → generic mono.
            { value: "'JetBrainsMono Nerd Font Mono', 'JetBrainsMono Nerd Font', 'JetBrains Mono', ui-monospace, monospace", label: 'JetBrainsMono Nerd Font' },
            { value: "'FiraCode Nerd Font Mono', 'FiraCode Nerd Font', 'Fira Code', ui-monospace, monospace",                label: 'FiraCode Nerd Font' },
            { value: "'Hack Nerd Font Mono', 'Hack Nerd Font', Hack, ui-monospace, monospace",                               label: 'Hack Nerd Font' },
            { value: "'MesloLGS NF', 'MesloLGM Nerd Font Mono', Menlo, ui-monospace, monospace",                             label: 'MesloLGS NF' },
            { value: "'CaskaydiaCove Nerd Font Mono', 'CaskaydiaCove Nerd Font', 'Cascadia Code', ui-monospace, monospace",  label: 'CaskaydiaCove Nerd Font' },
            { value: "'SauceCodePro Nerd Font Mono', 'SauceCodePro Nerd Font', 'Source Code Pro', ui-monospace, monospace",  label: 'SauceCodePro Nerd Font' },
            { value: 'monospace',                                   label: 'System monospace' },
        ];
        // Migration: a pre-existing free-text value that matches no option must survive.
        if (this.terminalFontFamily && !termFontOptions.some(o => o.value === this.terminalFontFamily)) {
            termFontOptions.splice(1, 0, { value: this.terminalFontFamily, label: `Current: ${this.terminalFontFamily}` });
        }
        // Custom uploaded font (Milestone 4): expose if active.
        if (this.customFontName) {
            termFontOptions.push({ value: 'Phi Custom Font', label: `Custom: ${this.customFontName}` });
        }
        const termFontRow = this._buildSelectRow('Terminal font', 'settings-term-font', termFontOptions, this.terminalFontFamily);
        appGroup.appendChild(termFontRow);

        // Terminal font size
        const termSizeRow = this._buildNumberRow('Terminal font size', 'settings-term-font-size', this.terminalFontSize || 14, 8, 32);
        appGroup.appendChild(termSizeRow);

        // Custom font upload — local-only (IndexedDB), never sent to the
        // server. Selectable afterward as "Custom: <name>" in both font
        // dropdowns above.
        const uploadRow = document.createElement('div');
        uploadRow.className = 'settings-row';
        const uploadLabel = document.createElement('label');
        uploadLabel.htmlFor = 'settings-font-upload';
        uploadLabel.textContent = 'Upload font…';
        uploadRow.appendChild(uploadLabel);
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.id = 'settings-font-upload';
        fileInput.accept = '.woff2,.woff,.ttf,.otf';
        uploadRow.appendChild(fileInput);
        appGroup.appendChild(uploadRow);

        // Reset appearance — clears the browser copy + pushes defaults to
        // the server so both stores agree (see AGENTS.md appearance notes).
        const resetRow = document.createElement('div');
        resetRow.className = 'settings-row';
        const resetBtn = document.createElement('button');
        resetBtn.className = 'btn';
        resetBtn.type = 'button';
        resetBtn.textContent = 'Reset appearance';
        resetRow.appendChild(resetBtn);
        appGroup.appendChild(resetRow);

        // Behavior group ────────────────────────────────────────
        const behGroup = this._buildSettingsGroup('Behavior');
        body.appendChild(behGroup);
        const reuseRow = this._buildCheckboxRow(
            'Reuse shell tab for terminal commands',
            'settings-reuse-shell-tab',
            !!this.useExistingTerminalTab,
        );
        behGroup.appendChild(reuseRow);
        // Master switch for automatic reconnection (wake / network-restore /
        // passive backoff redials of the active tab). Server default is
        // "visible"; mirror that when config has not loaded yet.
        const autoReconnectRow = this._buildCheckboxRow(
            'Auto-reconnect disconnected terminals (active tab)',
            'settings-auto-reconnect',
            ((this.config && this.config.auto_reconnect) || 'visible') === 'visible',
        );
        behGroup.appendChild(autoReconnectRow);

        // Security group ────────────────────────────────────────
        const PASSWORD_MIN_LENGTH = 8;
        const securityGroup = this._buildSettingsGroup('Security');
        body.appendChild(securityGroup);

        // Header row: label + state dot
        const headerRow = document.createElement('div');
        headerRow.className = 'settings-row settings-access-header';
        const headerLabel = document.createElement('span');
        headerLabel.className = 'settings-access-title';
        headerLabel.textContent = 'Access password';
        const stateDot = document.createElement('span');
        stateDot.className = 'settings-access-dot ' + (this.accessAuthEnabled ? 'is-on' : 'is-off');
        const stateText = document.createElement('span');
        stateText.className = 'settings-access-state-text';
        stateText.textContent = this.accessAuthEnabled ? 'Enabled' : 'Disabled';
        headerRow.append(headerLabel, stateDot, stateText);
        securityGroup.appendChild(headerRow);

        // New + confirm inputs. Two clean rows.
        const newInput = document.createElement('input');
        newInput.type = 'password';
        newInput.id = 'settings-access-new';
        newInput.autocomplete = 'new-password';
        newInput.placeholder = 'New password';
        const newRow = document.createElement('div');
        newRow.className = 'settings-row';
        newRow.appendChild(newInput);
        securityGroup.appendChild(newRow);

        const confirmInput = document.createElement('input');
        confirmInput.type = 'password';
        confirmInput.id = 'settings-access-confirm';
        confirmInput.autocomplete = 'new-password';
        confirmInput.placeholder = 'Confirm new password';
        const confirmRow = document.createElement('div');
        confirmRow.className = 'settings-row';
        confirmRow.appendChild(confirmInput);
        securityGroup.appendChild(confirmRow);

        // Hint line + inline error (replaces per-row toast noise).
        const hintRow = document.createElement('div');
        hintRow.className = 'settings-row settings-access-hint-row';
        const hint = document.createElement('span');
        hint.className = 'settings-access-hint';
        hint.textContent = `${PASSWORD_MIN_LENGTH}+ characters.`;
        const inlineError = document.createElement('span');
        inlineError.className = 'settings-access-error';
        inlineError.setAttribute('role', 'alert');
        hintRow.append(hint, inlineError);
        securityGroup.appendChild(hintRow);

        // Primary button + Remove link on a single row, right-aligned.
        const actionsRow = document.createElement('div');
        actionsRow.className = 'settings-row settings-access-actions-row';
        const setPasswordBtn = document.createElement('button');
        setPasswordBtn.className = 'btn btn-accent settings-access-primary';
        setPasswordBtn.type = 'button';
        setPasswordBtn.textContent = this.accessAuthEnabled ? 'Update password' : 'Set password';

        const removeLink = document.createElement('button');
        removeLink.className = 'settings-access-remove-link';
        removeLink.type = 'button';
        removeLink.textContent = '·  Remove password';
        removeLink.classList.toggle('hidden', !this.accessAuthEnabled);

        const confirmRemoveBtn = document.createElement('button');
        confirmRemoveBtn.className = 'btn btn-red settings-access-confirm-remove hidden';
        confirmRemoveBtn.type = 'button';
        confirmRemoveBtn.textContent = 'Confirm remove';

        const actionsSpacer = document.createElement('span');
        actionsSpacer.className = 'settings-access-spacer';
        actionsRow.append(actionsSpacer, setPasswordBtn, removeLink, confirmRemoveBtn);
        securityGroup.appendChild(actionsRow);

        const showError = (msg) => {
            inlineError.textContent = msg;
            if (msg) {
                newInput.classList.add('is-invalid');
                confirmInput.classList.add('is-invalid');
            } else {
                newInput.classList.remove('is-invalid');
                confirmInput.classList.remove('is-invalid');
            }
        };
        const clearInputs = () => {
            newInput.value = '';
            confirmInput.value = '';
            showError('');
        };

        // About group ───────────────────────────────────────────
        const aboutGroup = this._buildSettingsGroup('About');
        body.appendChild(aboutGroup);
        const hName = (this.hostname || '').toString();
        aboutGroup.appendChild(this._buildAboutRow('Hostname', hName.toUpperCase()));
        if (v.buildSource) {
            aboutGroup.appendChild(this._buildAboutRow('Build source', v.buildSource));
        }
        aboutGroup.appendChild(this._buildAboutRow('Workspaces', `${(this.sessionsManager?.workspaces || []).length}`));

        modal.appendChild(header);
        modal.appendChild(body);

        // ── Footer (Close only — no Save; settings live-apply) ───
        const footer = document.createElement('div');
        footer.className = 'modal-footer settings-footer';
        const doneBtn = document.createElement('button');
        doneBtn.className = 'btn btn-accent';
        doneBtn.type = 'button';
        doneBtn.textContent = 'Close';
        footer.appendChild(doneBtn);
        modal.appendChild(footer);

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        // ── Wiring ─────────────────────────────────────────────
        const close = () => {
            document.removeEventListener('keydown', onKeydown);
            overlay.classList.add('hidden');
            overlay.remove();
        };
        const onKeydown = (e) => { if (e.key === 'Escape') close(); };
        closeBtn.addEventListener('click', close);
        doneBtn.addEventListener('click', close);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        document.addEventListener('keydown', onKeydown);

        // Live font changes — debounced POST so rapid typing doesn't
        // hammer the backend. Family is applied immediately for
        // instant feedback; persist is debounced.
        let persistTimer = null;
        const debouncedPersist = () => {
            clearTimeout(persistTimer);
            persistTimer = setTimeout(() => this.persistAppearance(), 300);
        };
        uiFontRow.querySelector('select')?.addEventListener('change', (e) => {
            this.uiFontFamily = e.target.value;
            this.applyUIFont();
            this._saveAppearanceLocal();
            debouncedPersist();
        });
        uiSizeRow.querySelector('input')?.addEventListener('input', (e) => {
            const n = parseInt(e.target.value, 10);
            if (!Number.isFinite(n) || n < 10 || n > 24) return;
            this.uiFontSize = n;
            this.applyUIFont();
            this._saveAppearanceLocal();
            debouncedPersist();
        });
        termFontRow.querySelector('select')?.addEventListener('change', (e) => {
            this.terminalFontFamily = e.target.value;
            this.tabManager?.applyFontToAllActiveTerminals(this.terminalFontFamily || 'JetBrains Mono, monospace');
            this._saveAppearanceLocal();
            debouncedPersist();
        });
        termSizeRow.querySelector('input')?.addEventListener('input', (e) => {
            const n = parseInt(e.target.value, 10);
            if (!Number.isFinite(n) || n < 8 || n > 32) return;
            this.terminalFontSize = n;
            this.tabManager?.applyTerminalFontSizeToAll(n);
            this._saveAppearanceLocal();
            debouncedPersist();
        });
        fileInput.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const MAX = 8 * 1024 * 1024; // 8MB guard — generous for a font, bounds IndexedDB use
            if (file.size > MAX) { this.showToast('Font too large (max 8MB)', { type: 'error' }); return; }
            try {
                await this._putCustomFont(file.name, file);
                this._injectCustomFontFace(file);           // File is a Blob
                this.customFontName = file.name;
                this._saveAppearanceLocal();
                this.showToast(`Loaded ${file.name}. Pick "Custom: ${file.name}" in the font dropdowns.`, { type: 'success' });
                // Re-open/refresh the modal so both dropdowns show the new "Custom: …" option.
                // (Simplest: close + reopen, or append the option to both selects in place.)
            } catch (err) {
                this.showToast('Font upload failed: ' + err.message, { type: 'error' });
            }
        });
        resetBtn.addEventListener('click', async () => {
            try { localStorage.removeItem('phi_appearance'); } catch {}
            document.getElementById('phi-prepaint-appearance')?.remove();
            await this.clearCustomFont?.();               // Milestone 4: drop IndexedDB + <style> + name
            this.uiFontFamily = ''; this.uiFontSize = 0;
            this.terminalFontFamily = ''; this.terminalFontSize = 0;
            this.customFontName = '';
            this.applyUIFont();
            this.tabManager?.applyFontToAllActiveTerminals('JetBrains Mono, monospace');
            this.tabManager?.applyTerminalFontSizeToAll(0);
            // Push cleared state to the server so both stores agree.
            this.persistAppearance();
            // Reflect defaults in the open modal controls.
            document.getElementById('settings-ui-font').value = '';
            document.getElementById('settings-ui-font-size').value = '14';
            document.getElementById('settings-term-font').value = '';
            document.getElementById('settings-term-font-size').value = '14';
        });
        reuseRow.querySelector('input')?.addEventListener('change', async (e) => {
            this.useExistingTerminalTab = !!e.target.checked;
            try {
                await fetch('/api/config/use-existing-terminal-tab', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled: this.useExistingTerminalTab }),
                });
            } catch (err) {
                console.warn('[settings] failed to persist reuse-tab toggle', err);
            }
        });
        autoReconnectRow.querySelector('input')?.addEventListener('change', async (e) => {
            const enabled = !!e.target.checked;
            // app.config and sessionsManager.config are the same object
            // (mirrored in SessionsManager.loadConfig), so one write updates
            // every reader, including terminal.js's gate.
            if (this.config) this.config.auto_reconnect = enabled ? 'visible' : 'off';
            try {
                await fetch('/api/config/auto-reconnect', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled }),
                });
            } catch (err) {
                console.warn('[settings] failed to persist auto-reconnect toggle', err);
            }
        });
        setPasswordBtn.addEventListener('click', async () => {
            const newPw = newInput.value;
            const confirmPw = confirmInput.value;
            if (!newPw || newPw.length < PASSWORD_MIN_LENGTH) {
                showError(`At least ${PASSWORD_MIN_LENGTH} characters.`);
                newInput.focus();
                return;
            }
            if (newPw !== confirmPw) {
                showError('Passwords don\u2019t match.');
                confirmInput.focus();
                return;
            }
            setPasswordBtn.disabled = true;
            showError('');
            try {
                await setAccessPassword(newPw);
                clearInputs();
                this.accessAuthEnabled = true;
                stateDot.className = 'settings-access-dot is-on';
                stateText.textContent = 'Enabled';
                setPasswordBtn.textContent = 'Update password';
                removeLink.classList.remove('hidden');
                confirmRemoveBtn.classList.add('hidden');
                this.showToast('Password updated', { type: 'success' });
            } catch (err) {
                this.showToast(err instanceof Error ? err.message : 'Unable to save access password', { type: 'error' });
            } finally {
                setPasswordBtn.disabled = false;
            }
        });

        // Two-step Remove: click link → reveal Confirm button → click that.
        // No window.confirm(); the session cookie authorizes the action.
        removeLink.addEventListener('click', () => {
            removeLink.classList.add('hidden');
            confirmRemoveBtn.classList.remove('hidden');
            confirmRemoveBtn.focus();
        });
        confirmRemoveBtn.addEventListener('click', async () => {
            confirmRemoveBtn.disabled = true;
            try {
                await clearAccessPassword();
                this.accessAuthEnabled = false;
                stateDot.className = 'settings-access-dot is-off';
                stateText.textContent = 'Disabled';
                setPasswordBtn.textContent = 'Set password';
                removeLink.classList.add('hidden');
                confirmRemoveBtn.classList.add('hidden');
                this.showToast('Password removed', { type: 'success' });
            } catch (err) {
                this.showToast(err instanceof Error ? err.message : 'Unable to clear access password', { type: 'error' });
            } finally {
                confirmRemoveBtn.disabled = false;
            }
        });

        // Clear inline error on input — the user is fixing it.
        [newInput, confirmInput].forEach((el) => {
            el.addEventListener('input', () => showError(''));
        });

        requestAnimationFrame(() => overlay.classList.remove('hidden'));
    }

    _buildSettingsGroup(title) {
        const group = document.createElement('div');
        group.className = 'settings-group';
        const h = document.createElement('h4');
        h.className = 'settings-group-title';
        h.textContent = title;
        group.appendChild(h);
        return group;
    }

    _buildSwatchRow(activeColor) {
        const row = document.createElement('div');
        row.className = 'settings-row';
        const label = document.createElement('label');
        label.textContent = 'Highlight color';
        row.appendChild(label);
        const grid = document.createElement('div');
        grid.className = 'settings-swatch-grid';
        grid.setAttribute('role', 'radiogroup');
        grid.setAttribute('aria-label', 'Highlight color');
        Object.entries(ACCENT_COLORS).forEach(([key, theme]) => {
            const sw = document.createElement('button');
            sw.type = 'button';
            sw.className = 'settings-swatch';
            sw.setAttribute('role', 'radio');
            sw.setAttribute('aria-checked', key === activeColor ? 'true' : 'false');
            sw.dataset.color = key;
            sw.style.setProperty('--swatch', theme.accent);
            sw.title = key;
            sw.addEventListener('click', () => {
                this.applyAccentTheme(key);
                this.saveTheme(key);
                grid.querySelectorAll('.settings-swatch').forEach((s) => {
                    s.setAttribute('aria-checked', s.dataset.color === key ? 'true' : 'false');
                });
            });
            grid.appendChild(sw);
        });
        row.appendChild(grid);
        return row;
    }

    _buildSelectRow(labelText, id, options, current) {
        const row = document.createElement('div');
        row.className = 'settings-row';
        const label = document.createElement('label');
        label.htmlFor = id;
        label.textContent = labelText;
        row.appendChild(label);
        const sel = document.createElement('select');
        sel.id = id;
        options.forEach((o) => {
            const opt = document.createElement('option');
            opt.value = o.value;
            opt.textContent = o.label;
            if (o.value === current) opt.selected = true;
            sel.appendChild(opt);
        });
        row.appendChild(sel);
        return row;
    }

    _buildNumberRow(labelText, id, current, min, max) {
        const row = document.createElement('div');
        row.className = 'settings-row';
        const label = document.createElement('label');
        label.htmlFor = id;
        label.textContent = labelText;
        row.appendChild(label);
        const inp = document.createElement('input');
        inp.type = 'number';
        inp.id = id;
        inp.min = String(min);
        inp.max = String(max);
        inp.value = String(current || min);
        row.appendChild(inp);
        return row;
    }

    _buildInputRow(labelText, id, placeholder, current) {
        const row = document.createElement('div');
        row.className = 'settings-row';
        const label = document.createElement('label');
        label.htmlFor = id;
        label.textContent = labelText;
        row.appendChild(label);
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.id = id;
        inp.placeholder = placeholder;
        inp.value = current || '';
        row.appendChild(inp);
        return row;
    }

    _buildCheckboxRow(labelText, id, checked) {
        const row = document.createElement('div');
        row.className = 'settings-row';
        const label = document.createElement('label');
        label.htmlFor = id;
        label.textContent = labelText;
        row.appendChild(label);
        const inp = document.createElement('input');
        inp.type = 'checkbox';
        inp.id = id;
        inp.checked = !!checked;
        row.appendChild(inp);
        return row;
    }

    _buildAboutRow(k, v) {
        const row = document.createElement('div');
        row.className = 'settings-about-row';
        const key = document.createElement('span');
        key.textContent = k;
        const val = document.createElement('span');
        val.textContent = v;
        row.appendChild(key);
        row.appendChild(val);
        return row;
    }

    // _saveAppearanceLocal write-throughs the current appearance fields
    // to localStorage so they survive a server config reset (browser is
    // authoritative; server is the secondary mirror). Mirrors the
    // phi_theme_color pre-paint precedent.
    _saveAppearanceLocal() {
        try {
            localStorage.setItem('phi_appearance', JSON.stringify({
                ui_font_family: this.uiFontFamily || '',
                ui_font_size: this.uiFontSize || 0,
                terminal_font_family: this.terminalFontFamily || '',
                terminal_font_size: this.terminalFontSize || 0,
                custom_font_name: this.customFontName || '',
            }));
        } catch (e) { console.warn('[appearance] localStorage write failed', e); }
    }

    // _fontDB / _putCustomFont / _getCustomFont / _deleteCustomFont —
    // a tiny IndexedDB helper for the one active custom font. IndexedDB
    // (not localStorage) because font bytes can exceed localStorage's
    // ~5MB synchronous string quota; Blobs store natively with no
    // base64 inflation. Local-only: never sent to the server.
    _fontDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open('phi', 1);
            req.onupgradeneeded = () => req.result.createObjectStore('fonts');
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }
    async _putCustomFont(displayName, blob) {
        const db = await this._fontDB();
        await new Promise((res, rej) => {
            const tx = db.transaction('fonts', 'readwrite');
            tx.objectStore('fonts').put({ displayName, blob }, 'custom');
            tx.oncomplete = res; tx.onerror = () => rej(tx.error);
        });
    }
    async _getCustomFont() {
        const db = await this._fontDB();
        return new Promise((res, rej) => {
            const tx = db.transaction('fonts', 'readonly');
            const g = tx.objectStore('fonts').get('custom');
            g.onsuccess = () => res(g.result || null); g.onerror = () => rej(g.error);
        });
    }
    async _deleteCustomFont() {
        const db = await this._fontDB();
        await new Promise((res, rej) => {
            const tx = db.transaction('fonts', 'readwrite');
            tx.objectStore('fonts').delete('custom');
            tx.oncomplete = res; tx.onerror = () => rej(tx.error);
        });
    }

    // _injectCustomFontFace registers the uploaded font as the constant
    // family 'Phi Custom Font' via an object URL (avoids base64 inflation).
    _injectCustomFontFace(blob) {
        const url = URL.createObjectURL(blob);
        let styleEl = document.getElementById('phi-custom-fonts');
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = 'phi-custom-fonts';
            document.head.appendChild(styleEl);
        }
        styleEl.textContent =
            "@font-face{font-family:'Phi Custom Font';src:url(" + url + ");font-display:swap;}";
    }
    // loadCustomFont re-injects the @font-face from IndexedDB on boot.
    // Called from the sessions ingest after customFontName is set.
    async loadCustomFont() {
        if (!this.customFontName) return;
        try {
            const rec = await this._getCustomFont();
            if (rec?.blob) this._injectCustomFontFace(rec.blob);
        } catch (e) { console.warn('[font] load custom failed', e); }
    }
    // clearCustomFont drops the IndexedDB entry + <style> + name, and
    // falls back either surface that was using the custom font.
    async clearCustomFont() {
        try { await this._deleteCustomFont(); } catch {}
        document.getElementById('phi-custom-fonts')?.remove();
        this.customFontName = '';
        if (this.uiFontFamily === 'Phi Custom Font') { this.uiFontFamily = ''; this.applyUIFont(); }
        if (this.terminalFontFamily === 'Phi Custom Font') {
            this.terminalFontFamily = '';
            this.tabManager?.applyFontToAllActiveTerminals('JetBrains Mono, monospace');
        }
    }

    // applyUIFont writes the current uiFontFamily / uiFontSize to
    // document.body as inline style. We avoid introducing CSS custom
    // properties (per AGENTS.md) — inline styles keep the change
    // scoped and require no new tokens.
    applyUIFont() {
        const body = document.body;
        if (!body) return;
        if (this.uiFontFamily) {
            body.style.fontFamily = this.uiFontFamily;
        } else {
            body.style.removeProperty('font-family');
        }
        if (this.uiFontSize >= 10) {
            body.style.fontSize = `${this.uiFontSize}px`;
        } else {
            body.style.removeProperty('font-size');
        }
    }

    // persistAppearance POSTs the current uiFontFamily / uiFontSize /
    // terminalFontFamily to /api/config/appearance. Debounced at the
    // call site (300ms after the last input change).
    async persistAppearance() {
        try {
            await fetch('/api/config/appearance', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ui_font_family: this.uiFontFamily || '',
                    ui_font_size: this.uiFontSize || 0,
                    terminal_font_family: this.terminalFontFamily || '',
                    terminal_font_size: this.terminalFontSize || 0,
                }),
            });
        } catch (e) {
            console.warn('[appearance] failed to persist:', e);
        }
    }

    /**
     * Show a transient toast notification in the top-right corner.
     * @param {string} message - body text (the precise error/info)
     * @param {object} [opts]
     * @param {'error'|'info'|'success'} [opts.type='info']
     * @param {string} [opts.title] - bold heading; defaults based on type
     * @param {number} [opts.duration=6000] - ms before auto-dismiss; 0 to persist
     */
    showToast(message, opts = {}) {
        const { type = 'info', duration = 6000 } = opts;
        const title = opts.title || (
            type === 'error' ? "Couldn't open session"
            : type === 'success' ? 'Done'
            : 'Notice'
        );

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
        // Scarab (𓆣) for success = cyclical completion in the
        // Egyptian corpus. Replaces the generic checkmark for explicit
        // task-done toasts only; info/error keep their glyphs.
        icon.textContent = type === 'error' ? '⚠' : type === 'success' ? '𓆣' : 'ℹ';

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

        // Return the toast element so callers can dismiss it externally
        // (e.g. soft-close undo race). Internal code uses `dismiss()`.
        return toast;
    }

    openConfigEditor({ title, subtitle = '', fields = [], submitLabel = 'Save' }) {
        return new Promise((resolve) => {
            const existing = document.querySelector('.config-editor-overlay');
            if (existing) existing.remove();

            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay config-editor-overlay hidden';

            const modal = document.createElement('div');
            modal.className = 'modal-content config-editor-modal';

            const header = document.createElement('div');
            header.className = 'modal-header config-editor-header';

            const headerText = document.createElement('div');
            const titleEl = document.createElement('h3');
            titleEl.textContent = title;
            headerText.appendChild(titleEl);
            if (subtitle) {
                const subtitleEl = document.createElement('p');
                subtitleEl.className = 'config-editor-subtitle';
                subtitleEl.textContent = subtitle;
                headerText.appendChild(subtitleEl);
            }

            const closeBtn = document.createElement('button');
            closeBtn.className = 'modal-close-btn';
            closeBtn.type = 'button';
            closeBtn.textContent = 'x';
            closeBtn.title = 'Close';

            header.appendChild(headerText);
            header.appendChild(closeBtn);

            const body = document.createElement('form');
            body.className = 'modal-body config-editor-body';
            // Unique id so the submit button (which lives in the footer, OUTSIDE
            // this form element) can associate with the form via its `form`
            // attribute. Without this, clicking the type=submit button does
            // nothing because a submit button outside its form never submits.
            const formId = 'config-editor-form-' + Math.random().toString(36).slice(2);
            body.id = formId;

            const inputs = new Map();
            fields.forEach((field) => {
                const row = document.createElement('label');
                row.className = 'config-editor-field';
                row.htmlFor = `config-editor-${field.id}`;

                const label = document.createElement('span');
                label.textContent = field.label;
                row.appendChild(label);

                const input = field.multiline ? document.createElement('textarea') : document.createElement('input');
                input.id = `config-editor-${field.id}`;
                input.name = field.id;
                input.value = field.value || '';
                input.placeholder = field.placeholder || '';
                input.required = field.required !== false;
                if (!field.multiline) input.type = field.type || 'text';
                if (field.monospace !== false) input.classList.add('config-editor-mono');
                row.appendChild(input);

                inputs.set(field.id, input);
                body.appendChild(row);
            });

            const footer = document.createElement('div');
            footer.className = 'modal-footer config-editor-footer';

            const cancelBtn = document.createElement('button');
            cancelBtn.className = 'btn btn-primary';
            cancelBtn.type = 'button';
            cancelBtn.textContent = 'Cancel';

            const saveBtn = document.createElement('button');
            saveBtn.className = 'btn btn-accent';
            saveBtn.type = 'submit';
            saveBtn.setAttribute('form', formId);
            saveBtn.textContent = submitLabel;

            footer.appendChild(cancelBtn);
            footer.appendChild(saveBtn);

            modal.appendChild(header);
            modal.appendChild(body);
            modal.appendChild(footer);
            overlay.appendChild(modal);
            document.body.appendChild(overlay);

            let settled = false;
            const cleanup = (value) => {
                if (settled) return;
                settled = true;
                document.removeEventListener('keydown', onKeydown);
                overlay.classList.add('hidden');
                overlay.remove();
                resolve(value);
            };

            const onKeydown = (e) => {
                if (e.key === 'Escape') cleanup(null);
            };

            closeBtn.addEventListener('click', () => cleanup(null));
            cancelBtn.addEventListener('click', () => cleanup(null));
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) cleanup(null);
            });
            body.addEventListener('submit', (e) => {
                e.preventDefault();
                const values = {};
                for (const [id, input] of inputs.entries()) {
                    const value = input.value.trim();
                    if (input.required && !value) {
                        input.focus();
                        return;
                    }
                    values[id] = value;
                }
                cleanup(values);
            });
            document.addEventListener('keydown', onKeydown);

            requestAnimationFrame(() => {
                overlay.classList.remove('hidden');
                const firstInput = body.querySelector('input, textarea');
                firstInput?.focus({ preventScroll: true });
                firstInput?.select?.();
            });
        });
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
            
            // Fallback for single quick command / array of commands JSON
            if (prefix === "PHICMDS" && (configText.startsWith("{") || configText.startsWith("["))) {
                try {
                    const data = JSON.parse(configText);
                    const isValidSingle = data && typeof data === 'object' && !Array.isArray(data) && data.name && data.command;
                    const isValidArray = Array.isArray(data) && data.every(item => item && typeof item === 'object' && item.name && item.command);

                    if (isValidSingle || isValidArray) {
                        if (isValidArray) {
                            const confirmOverwrite = confirm(`Do you want to overwrite all your quick commands with these ${data.length} commands?`);
                            if (!confirmOverwrite) {
                                if (btnElement) btnElement.classList.remove('loading');
                                return;
                            }
                        }

                        const res = await fetch('/api/config/quick-commands', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(data)
                        });

                        if (!res.ok) {
                            const text = await res.text();
                            throw new Error(text || "Failed to import quick commands");
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
                        return;
                    }
                } catch (e) {
                    console.warn("[config] Attempted to parse commands JSON but failed, falling back to prefix check", e);
                }
            }
            
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

    // v0.7.16: cmds split into quick (sent to active PTY) vs terminal
    // (spawn new shell tabs). They were conflated under /export-cmds and
    // called "the same thing" because the button text was the same. They
    // are not the same thing. Two separate endpoints, two separate methods.
    async exportQuickCommandsConfig(btnElement) {
        await this._doExportConfig('/api/config/export-quick-commands', btnElement);
    }

    async exportTerminalCommandsConfig(btnElement) {
        await this._doExportConfig('/api/config/export-terminal-commands', btnElement);
    }

    async importCmdsConfig(btnElement) {
        await this._doImportConfig('/api/config/import-cmds', btnElement, "PHICMDS", async () => {
            await this.sessionsManager.loadConfig();
        });
    }

    // ─── Fleet panel (Phase 6 / plan §3.4) ────────────────────────────
    // Polls /api/peers/status every 15s while the sidebar is visible.
    // The poller itself is server-side and runs unconditionally; the
    // client just renders the cached snapshot and skips HTTP round-trips
    // when the user isn't looking. This protects sleepy laptops from a
    // 2 GETs/15s/peer heartbeat (risk R9).
    startFleetPolling() {
        if (this._fleetPollTimer) return; // idempotent

        const isSidebarVisible = () => {
            const sidebar = document.getElementById('sidebar-panel');
            if (!sidebar) return true;
            return getComputedStyle(sidebar).display !== 'none';
        };

        const poll = async () => {
            if (!isSidebarVisible()) return;
            try {
                const res = await fetch('/api/peers/status');
                if (!res.ok) return;
                const statuses = await res.json();
                this.renderFleetPanel(statuses);
            } catch (err) {
                console.warn('[fleet] poll failed:', err);
            }
        };

        poll(); // immediate first poll
        this._fleetPollTimer = setInterval(poll, 15000);
    }

    renderFleetPanel(statuses) {
        const panel = document.getElementById('fleet-panel');
        const list = document.getElementById('fleet-peer-list');
        const badge = document.getElementById('fleet-stale-badge');
        if (!panel || !list) return;

        if (!Array.isArray(statuses) || statuses.length === 0) {
            panel.style.display = 'none';
            return;
        }
        panel.style.display = '';

        // Clear via replaceChildren; safe and doesn't fight with browser extensions.
        list.replaceChildren();

        let anyAttention = false;
        for (const peer of statuses) {
            const state = !peer.reachable
                ? 'unreachable'
                : peer.stale
                    ? 'stale'
                    : 'reachable';
            if (state !== 'reachable') anyAttention = true;

            const row = document.createElement('button');
            row.type = 'button';
            row.className = `fleet-peer-row ${state}`;

            const dot = document.createElement('span');
            dot.className = `fleet-peer-dot ${state}`;

            const name = document.createElement('span');
            name.className = 'fleet-peer-name';
            name.textContent = peer.name || peer.url || 'peer';

            const meta = document.createElement('span');
            meta.className = 'fleet-peer-meta';
            if (peer.reachable) {
                const busyHtml = peer.busy_count > 0
                    ? `<span class="fleet-peer-busy">${peer.busy_count}b</span> `
                    : '';
                const idle = peer.idle_min < 0 ? '?' : `${peer.idle_min}m`;
                const ver = peer.version
                    ? `<span class="fleet-peer-version">${escapeHtml(peer.version)}</span>`
                    : '';
                meta.innerHTML = `${peer.tab_count}t ${busyHtml}· ${idle}${ver}`;
            } else {
                meta.textContent = 'offline';
            }

            row.appendChild(dot);
            row.appendChild(name);
            row.appendChild(meta);

            if (peer.reachable) {
                row.title = `${peer.url}\n${peer.tab_count} tabs · ${peer.busy_count} busy\nphi ${peer.version || 'unknown'}\nidle ${peer.idle_min < 0 ? '?' : peer.idle_min + 'm'}`;
                row.addEventListener('click', () => {
                    if (peer.url) window.open(peer.url, '_blank', 'noopener');
                });
            } else {
                row.title = `${peer.url}\nunreachable${peer.error ? ': ' + peer.error : ''}`;
                row.disabled = true;
            }

            list.appendChild(row);
        }

        if (badge) {
            badge.style.display = anyAttention ? '' : 'none';
        }
    }

    async loadVersion() {
        try {
            const res = await fetch('/api/version');
            if (res.ok) {
                const data = await res.json();
                this.versionInfo = data;
                // Detect server restart by comparing the server's
                // started_at to the value we cached last session. A
                // newer value means the server died and was restarted
                // — the tabs the user had in the old server are gone
                // forever (their PTY processes died with it). Clear
                // localStorage references to dead tabs and toast the
                // user so they don't think "where did my tabs go?"
                if (data.started_at) {
                    const lastSeen = localStorage.getItem('phi_server_started_at');
                    if (lastSeen && lastSeen !== data.started_at) {
                        const hadTabs = localStorage.getItem('phi_active_pane')
                            || localStorage.getItem('phi_tab_order');
                        if (hadTabs) {
                            localStorage.removeItem('phi_active_pane');
                            localStorage.removeItem('phi_tab_order');
                            this.showToast(
                                'Server restarted — previous tabs are gone (PTY processes died with the server).',
                                { type: 'info', title: 'Fresh start', duration: 8000 },
                            );
                        }
                    }
                    localStorage.setItem('phi_server_started_at', data.started_at);
                }
                const changelogBtn = document.getElementById('phi-changelog-btn');
                if (changelogBtn) {
                    // Only overwrite the HTML default when the binary reports
                    // a real version (i.e. a stamped release build). A
                    // `go run` / `go build` without ldflags reports "dev" -
                    // in that case we keep whatever the HTML shipped, which
                    // is the most recent release tag. The button always shows
                    // something useful instead of flashing "dev".
                    const ver = data.version;
                    if (ver && ver !== 'dev') {
                        changelogBtn.textContent = ver.startsWith('v') ? ver : `v${ver}`;
                    }
                }
                // Once we know the install method, kick off the update check
                // (server-side throttled; this is just the UI hookup).
                this.checkForUpdate();
            }
        } catch (err) {
            console.error('Failed to load version:', err);
        }
    }

    // checkForUpdate — Phase 7 T1 (plan §3.5). Polls /api/update/status;
    // if update_available, adds a subtle dot to the version pill + stashes
    // the full status on this.updateStatus for the popup. Throttled by
    // the server (24h ticker + 6h floor) so this is cheap to call.
    async checkForUpdate() {
        try {
            const res = await fetch('/api/update/status');
            if (!res.ok) return;
            const data = await res.json();
            this.updateStatus = data;
            this.renderUpdateBadge(data);
        } catch (err) {
            console.warn('[update] check failed:', err);
        }
    }

    renderUpdateBadge(status) {
        const btn = document.getElementById('phi-changelog-btn');
        if (!btn || !status) return;
        // Don't badge "dev" builds — checker skipped those server-side,
        // but defense in depth.
        if (!status.update_available || status.current === 'dev') {
            btn.classList.remove('has-update');
            return;
        }
        btn.classList.add('has-update');
        btn.title = `Update available: ${status.latest}\n${status.instructions || ''}`;
    }
}

// Start Application on DOM Load. Access bootstrap happens before App.init so
// protected API calls and PTY WebSockets never start before authentication.
window.addEventListener('DOMContentLoaded', async () => {
    try {
        const auth = await bootstrapAccessAuth();
        const app = new App();
        app.accessAuthEnabled = auth.enabled;
        app.init();
    } catch (err) {
        console.error('[auth] Phi startup blocked:', err);
        const overlay = document.createElement('div');
        overlay.className = 'access-auth-overlay';
        const dialog = document.createElement('div');
        dialog.className = 'access-auth-dialog';
        const title = document.createElement('h1');
        title.textContent = 'Unable to open Phi';
        const detail = document.createElement('p');
        detail.textContent = err instanceof Error ? err.message : 'Access protection could not start';
        dialog.append(title, detail);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
    }
});
