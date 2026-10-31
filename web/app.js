import {
    TabManager,
    termPerfMark,
    termPerfMeasureBetween,
} from './terminal.js';
import { SessionsManager } from './sessions.js';
import { loadCoderRegistry, listCoders, rebuildRegistry } from './coders.js';
import { DiffController } from './diff.js';
import { MarkdownManager } from './markdown.js';
import { FileTreeManager } from './filetree.js';
import { KanbanManager } from './kanban.js';
import {
    escapeHtml,
    buildPhiFaviconSvg,
    isCoarseViewport,
    isCompactViewport,
    isSidebarDrawerViewport,
    isDiffDrawerViewport,
    visibleViewportHeight,
    COMPACT_VIEWPORT_QUERY,
    SIDEBAR_PANEL_CAP,
    DIFF_PANEL_CAP,
    clampPanelWidth,
    setServerHostOverride,
    openExternalLink,
    resolveLowPowerEnabled,
    writeLowPowerLocal,
    serverKey,
    setEmbeddedBackend,
    getEmbeddedProfileId,
    getEmbeddedBackendOrigin,
} from './util.js';
import { BackendScope } from './backend-scope.js';
import {
    MobileAppearanceStore, EMPTY_MOBILE, captureAppearanceScope,
    appearanceRequestContext, appearanceOwner, currentAppearanceProfile,
    effectiveAppearance, applyAppearanceFonts, legacyAppearanceKey,
    readDesktopAppearance,
} from './mobile-appearance.js';
import { BackendStore, backendStores } from './backend-store.js';
import { NotificationManager } from './notifications.js';
import { SyncManager } from './sync.js';
import { initQuotaButton } from './quota.js';
import { bootstrapAccessAuth } from './auth.js';
import { openSettingsModal, broadcastConfigSync } from './settings.js';
import { markDesktopView } from './desktop.js';
import { formatPickedDir, mountDirectoryTree } from './path-picker.js';
import { ACCENT_COLORS, applyThemeTokens } from './theme.js';
export { ACCENT_COLORS };

function inertBodyExceptNotifications() {
    const body = document.body;
    if (!body) return () => {};
    const exemptRoots = [
        document.getElementById('header-notifications-btn'),
        document.getElementById('notifications-overlay'),
    ].filter((element) => element instanceof HTMLElement);
    const saved = [];
    const inertBranch = (element) => {
        if (exemptRoots.includes(element)) return;
        if (exemptRoots.some((root) => element.contains(root))) {
            for (const child of Array.from(element.children)) {
                if (child instanceof HTMLElement) inertBranch(child);
            }
            return;
        }
        saved.push({ element, inert: element.inert });
        element.inert = true;
    };
    for (const child of Array.from(body.children)) {
        if (child instanceof HTMLElement) inertBranch(child);
    }
    return () => {
        for (const entry of saved) entry.element.inert = entry.inert;
    };
}

markDesktopView();

export class App {
    constructor(scope) {
        if (typeof window !== 'undefined' && window.location?.search) {
            const params = new URLSearchParams(window.location.search);
            const profileId = params.get('profile');
            const origin = params.get('origin');
            if (profileId) {
                setEmbeddedBackend(profileId, origin || '');
            }
        }
        this.scope = scope || new BackendScope(
            getEmbeddedProfileId() || '',
            getEmbeddedBackendOrigin() || '',
        );
        this._defaultStore = new BackendStore('__default__');
        this._initializedOnce = false;
        this._switchSeq = 0;
        this._switchChain = Promise.resolve(true);
        if (typeof window !== 'undefined') {
            window.__phiEmbed = {
                switchTo: (id, origin = '') => this.switchToBackend(id, origin),
                forget: (id) => this.forgetBackend(id),
            };
        }

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
        this.mobileScrollbackRows = 0;
        // Alternate server hostname for socket URLs. Blank (default)
        // means the page host — fully backwards compatible.
        this.hostnameOverride = '';
        this.customFontName = '';
        this.terminalBgName = '';
        this.terminalBgDarkness = 98;
        this.terminalBgBlur = 0;
        this._terminalBgObjectUrl = null;
        this.accessAuthEnabled = false;
        this._isDraggingDrawer = false;
        this.notifications = null;
        if (document.getElementById('header-notifications-btn')) {
            this.getNotifications();
        }

        // Instantiate controllers
        this.tabManager = new TabManager(this);
        this.sessionsManager = new SessionsManager(this);
        this.diffController = new DiffController(this);
        this.markdownManager = new MarkdownManager(this);
        this.fileTreeManager = new FileTreeManager(this);
        this.kanbanManager = new KanbanManager(this);
        this.syncManager = new SyncManager(this);
        this.initAppearance();
    }

    async init() {
        // Effects profile: apply synchronously before any await so a
        // mobile viewport never renders the expensive visuals (every
        // gated animation is JS-state-gated, so pre-script frames can
        // only show static blur), then re-apply on breakpoint crossings
        // (phone rotation, window resize).
        this.applyFastMode();

        // Settings and local controls are usable while background reads run.
        this.initOnce();
        await this.revalidate(this.scope);
        console.log('[app] Phi initialized successfully');
    }

    async revalidate(scope = this.scope) {
        if (scope?.aborted) return;
        if (typeof document !== 'undefined' && document.documentElement) {
            document.documentElement.dataset.sync = 'stale';
        }
        try {
            const savedTheme =
                localStorage.getItem(serverKey('phi_theme_color')) ||
                localStorage.getItem('phi_theme_color');
            if (savedTheme) {
                this.applyAccentTheme(savedTheme);
            }
            // The version and coder probes do not depend on each other and
            // do not feed the workspace state, so they run together: a
            // remote server's round trip is the switch's dominant cost, and
            // awaiting them one after another made the switch cost the SUM
            // of the round trips instead of the slowest one.
            //
            // The workspace config MUST land before the terminal list is
            // restored: the restored tabs resolve their cwd and workspace
            // against the active workspace, and a racing restore would
            // leave the active cwd pointing at the wrong directory.
            await Promise.all([
                this.loadVersion(scope),
                this.fetchCoderPresets(scope),
            ]);
            if (scope?.aborted) return;
            await this.sessionsManager.loadConfig();
            if (scope?.aborted) return;
            await this.tabManager.restoreTabsState(scope);
            if (scope?.aborted) return;
            // The right-panel endpoints use headerless fetches, which
            // route through the active-profile pointer. Refresh after
            // config and restored tabs land so both routing and cwd
            // belong to this backend. Sync's poller below does its own
            // immediate refresh.
            if (this.diffController?.activeTab !== 'sync') {
                void Promise.resolve(
                    this.diffController?.refreshDiff?.(false, {
                        silent: true,
                    }),
                ).catch(() => {});
            }
            this.startFleetPolling(scope);
            this.syncManager?.startPolling?.(scope);
        } finally {
            if (
                !scope?.aborted &&
                this.scope === scope &&
                typeof document !== 'undefined' &&
                document.documentElement
            ) {
                delete document.documentElement.dataset.sync;
            }
        }
    }

    initOnce() {
        if (this._initializedOnce) return;
        this._initializedOnce = true;

        if (typeof window.matchMedia === 'function') {
            window
                .matchMedia(COMPACT_VIEWPORT_QUERY)
                .addEventListener('change', () => {
                    this.applyFastMode();
                    // Leaving the compact layout drops the drawer to its
                    // sessions content, so the heading must follow.
                    if (!isCompactViewport()) this.setDrawerMode('sessions');
                });
        }

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
                const existing = document.querySelector('.settings-overlay');
                if (existing) {
                    existing.querySelector('.modal-close-btn')?.click();
                    return;
                }
                this.openSettingsModal();
            });
        }

        document.getElementById('drawer-settings-btn')?.addEventListener('click', () => {
            document.getElementById('sidebar-panel')?.classList.remove('drawer-open');
            this.openSettingsModal({ opener: document.getElementById('drawer-settings-btn') });
        });

        // 6.2 Listen for cross-window settings/theme sync (e.g. from standalone /config.html)
        this.initCrossWindowConfigSync();

        // 7. Setup mobile sidebar drawer toggle
        const mobileSidebarToggle = document.getElementById(
            'mobile-sidebar-toggle',
        );
        const sidebar = document.getElementById('sidebar-panel');
        if (mobileSidebarToggle && sidebar) {
            mobileSidebarToggle.addEventListener('click', (e) => {
                e.stopPropagation();
                if (sidebar.classList.contains('drawer-open')) {
                    sidebar.classList.remove('drawer-open');
                } else {
                    this.openTabsDrawer();
                }
            });

            document
                .getElementById('drawer-open-sessions')
                ?.addEventListener('click', () =>
                    this.setDrawerMode('sessions'),
                );
            document
                .getElementById('drawer-back-to-tabs')
                ?.addEventListener('click', () => this.setDrawerMode('tabs'));

            // Close drawer when clicking outside it
            document.addEventListener('click', (e) => {
                if (this._isDraggingDrawer) return;
                if (
                    sidebar.classList.contains('drawer-open') &&
                    !sidebar.contains(e.target) &&
                    e.target !== mobileSidebarToggle
                ) {
                    sidebar.classList.remove('drawer-open');
                }
            });
        }

        // Intercept external links clicked in markdown modals, chat, diffs, etc.
        // In browser: opens in new tab; in Electron: opens in default OS browser.
        document.addEventListener('click', (e) => {
            const target = e.target;
            if (!target || typeof target.closest !== 'function') return;
            const a = target.closest('a[href]');
            if (!a) return;
            const href = a.getAttribute('href');
            if (
                !href ||
                href.startsWith('#') ||
                href.startsWith('javascript:')
            ) {
                return;
            }
            try {
                const parsed = new URL(a.href);
                const isExternal =
                    parsed.origin !== window.location.origin ||
                    a.getAttribute('target') === '_blank';
                if (
                    isExternal &&
                    (parsed.protocol === 'http:' ||
                        parsed.protocol === 'https:' ||
                        parsed.protocol === 'mailto:')
                ) {
                    e.preventDefault();
                    openExternalLink(a.href);
                }
            } catch {}
        });

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
                            cwd:
                                this.sessionsManager.activeCWD ||
                                this.sessionsManager.activeWorkspace,
                            session_id: '',
                            title: 'btop',
                            workspace:
                                this.sessionsManager.activeWorkspace || '',
                        }),
                    });
                    if (!res.ok)
                        throw new Error('Failed to spawn btop session');
                    const data = await res.json();

                    this.tabManager.createTab(
                        data.pane_id,
                        data.session_id,
                        `btop`,
                        'bash',
                        this.sessionsManager.activeWorkspace,
                        this.sessionsManager.activeCWD,
                    );

                    const checkWs = setInterval(() => {
                        const tab = this.tabManager.tabs.get(data.pane_id);
                        if (
                            tab?.ws?.ws &&
                            tab.ws.ws.readyState === WebSocket.OPEN
                        ) {
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

        // The legacy static quick-launch listener was bound here, after
        // initial config and tab restoration. Delegation is installed
        // earlier, but clicks become active at the same point as before.
        this.sessionsManager.quickLaunchReady = true;

        const ntfyBtn = document.getElementById('header-ntfy-btn');
        const pushoverModal = document.getElementById('pushover-modal');
        const pushoverClose = document.getElementById('pushover-modal-close');

        const simplepushToggle = document.getElementById(
            'simplepush-enabled-toggle',
        );
        const simplepushKeyInput = document.getElementById(
            'simplepush-key-input',
        );
        const simplepushSaveBtn = document.getElementById(
            'simplepush-save-btn',
        );
        const simplepushTestBtn = document.getElementById(
            'simplepush-test-btn',
        );

        const pushoverToggle = document.getElementById(
            'pushover-enabled-toggle',
        );
        const pushoverUserKeyInput = document.getElementById(
            'pushover-user-key-input',
        );
        const pushoverAppTokenInput = document.getElementById(
            'pushover-app-token-input',
        );
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
                        fetch('/api/config/webhook'),
                    ]);
                    if (resS.ok) {
                        const dataS = await resS.json();
                        if (simplepushKeyInput)
                            simplepushKeyInput.value =
                                dataS.simplepush_key || '';
                        if (simplepushToggle)
                            simplepushToggle.checked =
                                !!dataS.simplepush_enabled;
                    }
                    if (resP.ok) {
                        const dataP = await resP.json();
                        if (pushoverUserKeyInput)
                            pushoverUserKeyInput.value =
                                dataP.pushover_user_key || '';
                        if (pushoverAppTokenInput)
                            pushoverAppTokenInput.value =
                                dataP.pushover_app_token || '';
                        if (pushoverToggle)
                            pushoverToggle.checked = !!dataP.pushover_enabled;
                    }
                    if (resW.ok) {
                        const dataW = await resW.json();
                        if (webhookUrlInput)
                            webhookUrlInput.value = dataW.webhook_url || '';
                        if (webhookToggle)
                            webhookToggle.checked = !!dataW.webhook_enabled;
                    }
                } catch (e) {
                    console.error('Failed to fetch notification config:', e);
                }
                pushoverModal.classList.remove('hidden');
            });

            pushoverClose?.addEventListener('click', () => {
                pushoverModal.classList.add('hidden');
            });
            // Escape closes the pushover modal — matches the pattern in
            // markdown.js (md-modal), app.js (ws-modal), diff.js (diff-modal).
            document.addEventListener('keydown', (e) => {
                if (
                    e.key === 'Escape' &&
                    !pushoverModal.classList.contains('hidden')
                ) {
                    pushoverModal.classList.add('hidden');
                }
            });

            const saveSimplepushConfig = async () => {
                try {
                    await fetch('/api/config/simplepush', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            simplepush_key:
                                simplepushKeyInput?.value.trim() || '',
                            simplepush_enabled: !!simplepushToggle?.checked,
                        }),
                    });
                } catch (e) {
                    console.error('Failed to save simplepush config:', e);
                }
            };

            const savePushoverConfig = async () => {
                try {
                    await fetch('/api/config/pushover', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            pushover_user_key:
                                pushoverUserKeyInput?.value.trim() || '',
                            pushover_app_token:
                                pushoverAppTokenInput?.value.trim() || '',
                            pushover_enabled: !!pushoverToggle?.checked,
                        }),
                    });
                } catch (e) {
                    console.error('Failed to save pushover config:', e);
                }
            };

            const saveWebhookConfig = async () => {
                try {
                    await fetch('/api/config/webhook', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            webhook_url: webhookUrlInput?.value.trim() || '',
                            webhook_enabled: !!webhookToggle?.checked,
                        }),
                    });
                } catch (e) {
                    console.error('Failed to save webhook config:', e);
                }
            };

            simplepushToggle?.addEventListener('change', saveSimplepushConfig);
            simplepushSaveBtn?.addEventListener('click', async () => {
                await saveSimplepushConfig();
                const origText = simplepushSaveBtn.textContent;
                simplepushSaveBtn.textContent = 'Saved ✓';
                setTimeout(() => {
                    simplepushSaveBtn.textContent = origText;
                }, 1500);
            });

            pushoverToggle?.addEventListener('change', savePushoverConfig);
            pushoverSaveBtn?.addEventListener('click', async () => {
                await savePushoverConfig();
                const origText = pushoverSaveBtn.textContent;
                pushoverSaveBtn.textContent = 'Saved ✓';
                setTimeout(() => {
                    pushoverSaveBtn.textContent = origText;
                }, 1500);
            });

            webhookToggle?.addEventListener('change', saveWebhookConfig);
            webhookSaveBtn?.addEventListener('click', async () => {
                await saveWebhookConfig();
                const origText = webhookSaveBtn.textContent;
                webhookSaveBtn.textContent = 'Saved ✓';
                setTimeout(() => {
                    webhookSaveBtn.textContent = origText;
                }, 1500);
            });

            simplepushTestBtn?.addEventListener('click', async () => {
                await saveSimplepushConfig();
                const origText = simplepushTestBtn.textContent;
                simplepushTestBtn.disabled = true;
                simplepushTestBtn.textContent = 'Sending...';
                try {
                    const res = await fetch('/api/config/simplepush/test', {
                        method: 'POST',
                    });
                    if (!res.ok) {
                        const err = await res.text();
                        alert(`Test Simplepush failed: ${err}`);
                    } else {
                        simplepushTestBtn.textContent = 'Sent ✓';
                        setTimeout(() => {
                            simplepushTestBtn.textContent = origText;
                            simplepushTestBtn.disabled = false;
                        }, 2000);
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
                    const res = await fetch('/api/config/pushover/test', {
                        method: 'POST',
                    });
                    if (!res.ok) {
                        const err = await res.text();
                        alert(`Test notification failed: ${err}`);
                    } else {
                        pushoverTestBtn.textContent = 'Sent ✓';
                        setTimeout(() => {
                            pushoverTestBtn.textContent = origText;
                            pushoverTestBtn.disabled = false;
                        }, 2000);
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
                    const res = await fetch('/api/config/webhook/test', {
                        method: 'POST',
                    });
                    if (!res.ok) {
                        const err = await res.text();
                        alert(`Test webhook failed: ${err}`);
                    } else {
                        webhookTestBtn.textContent = 'Sent ✓';
                        setTimeout(() => {
                            webhookTestBtn.textContent = origText;
                            webhookTestBtn.disabled = false;
                        }, 2000);
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
        // Define this even when old Chromium lacks visualViewport. Android
        // Chrome's window.innerHeight is the only usable fallback there;
        // modern Safari/Chromium still take the visualViewport path through
        // visibleViewportHeight().
        this.updateLayoutPosition = (
            shouldFit = false,
            resetDocumentScroll = false,
        ) => {
            const isDesktop = new URLSearchParams(window.location.search).has(
                'desktop',
            );
            // Soft-keyboard ergonomics are capability-based, not
            // width-based: an 820px iPad is a touch device whose on-screen
            // keyboard must not cover the input bar. Fine-pointer shells
            // (and the ?desktop embed) never get --vv-height written, so
            // their CSS fallback is pixel-identical to a desktop browser.
            const isTouchShell = !isDesktop && isCoarseViewport();
            const height = visibleViewportHeight();
            if (isTouchShell && height > 0) {
                document.documentElement.style.setProperty(
                    '--vv-height',
                    `${height}px`,
                );

                // iOS may move the document to reveal a focused input.
                // Correct that specific focus side effect only; doing this
                // for every scroll event steals terminal/page scrolling.
                if (
                    resetDocumentScroll &&
                    (window.scrollY > 0 || window.scrollX > 0)
                ) {
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

        // Keyboard geometry changes are layout events, so they may correct
        // iOS focus-scroll; visualViewport scroll remains a user gesture and
        // must never reset the document origin. Old Chromium has no
        // visualViewport, but its window resize/orientation/page-show events
        // still refresh the innerHeight fallback.
        //
        // NEVER contract: the var + focus-scroll fix go immediately (the
        // input bar must ride the keyboard), but NOTHING else — no fit,
        // no PTY send, no scroll touch. Frozen rows both ways.
        window.visualViewport?.addEventListener('resize', () => {
            this.updateLayoutPosition(false, true);
        });
        window.visualViewport?.addEventListener('scroll', () =>
            this.updateLayoutPosition(false),
        );
        window.addEventListener('resize', () =>
            this.updateLayoutPosition(false),
        );
        window.addEventListener('orientationchange', () =>
            this.updateLayoutPosition(true),
        );
        window.addEventListener('pageshow', () =>
            this.updateLayoutPosition(true),
        );

        // Run initially to position correctly.
        this.updateLayoutPosition(true);

        // Prevent pinch-to-zoom gestures on mobile viewports
        document.addEventListener(
            'touchstart',
            (e) => {
                if (e.touches.length > 1) {
                    e.preventDefault();
                }
            },
            { passive: false },
        );

        document.addEventListener(
            'gesturestart',
            (e) => {
                e.preventDefault();
            },
            { passive: false },
        );

        // 10. Swipe Gestures for Drawers on Mobile
        this.setupMobileGestures();

        // 11. Sidebar quota button (footer pill, next to ?).
        initQuotaButton();
    }

    getActiveStore(profileId = getEmbeddedProfileId()) {
        return profileId ? backendStores.get(profileId) : this._defaultStore;
    }

    paintBackendFromStore(store) {
        if (!store) return false;
        if (store.responses?.has('/api/version')) {
            try {
                const versionData = JSON.parse(store.responses.get('/api/version'));
                this.applyVersionData(versionData, { checkUpdate: false });
            } catch {}
        }
        if (store.responses?.has('/api/coders')) {
            try {
                const codersData = JSON.parse(store.responses.get('/api/coders'));
                rebuildRegistry(codersData);
                const coders = listCoders();
                this.codersPresetRegistry = Object.fromEntries(
                    coders.map((c) => [c.id, c]),
                );
            } catch {}
        }
        if (store.responses?.has('/api/config')) {
            try {
                const configData = JSON.parse(store.responses.get('/api/config'));
                this.sessionsManager?.applyConfigData?.(configData, { stale: true });
            } catch {}
        }
        if (store.activeCwd && this.sessionsManager) {
            this.sessionsManager.activeCWD = store.activeCwd;
        }
        const wsKey = `/api/git/worktrees?cwd=${encodeURIComponent(this.sessionsManager?.activeWorkspace || '')}`;
        const worktreesData = this.sessionsManager?.readCachedWorktrees?.(
            store,
            wsKey,
        );
        if (worktreesData !== null && worktreesData !== undefined) {
            this.sessionsManager?.renderWorktreesList?.(
                worktreesData,
                this.sessionsManager.activeWorkspace,
                store.activeCwd,
                { loadSessions: false },
            );
        }
        if (store.tabs !== null) {
            this.tabManager?.paintFromStore?.(store);
        }
        if (store.responses?.has('/api/peers/status')) {
            try {
                const peersData = JSON.parse(store.responses.get('/api/peers/status'));
                this.renderFleetPanel(peersData);
            } catch {}
        }
        if (store.responses?.has('/api/sync/messages')) {
            try {
                const syncData = JSON.parse(store.responses.get('/api/sync/messages'));
                this.syncManager?.renderMessages?.(syncData);
            } catch {}
        } else {
            // The sync panel is persistent DOM in single-tab mode. Never
            // leave another backend's messages visible on a cache miss.
            this.syncManager?.renderMessages?.([]);
        }
        return true;
    }

    switchToBackend(profileId, origin = '') {
        if (!profileId) return Promise.resolve(false);
        this.getNotifications().setActionsBlocked(true);
        const switchStart = globalThis.performance?.now?.();
        termPerfMark('switch-start');
        const seq = ++this._switchSeq;
        this.scope?.abort?.();
        this._switchChain = this._switchChain
            .catch(() => {})
            .then(() => this._performSwitch(profileId, origin, seq))
            .finally(() => {
                termPerfMeasureBetween('switch-total', switchStart);
            });
        return this._switchChain;
    }

    async _performSwitch(profileId, origin, seq) {
        const notifications = this.getNotifications();
        notifications.setActionsBlocked(true);
        let phaseStart = globalThis.performance?.now?.();
        try {
            this.initOnce();
        } finally {
            termPerfMeasureBetween('switch-init', phaseStart);
        }
        phaseStart = globalThis.performance?.now?.();
        const prevProfileId = getEmbeddedProfileId();
        const prevOrigin = getEmbeddedBackendOrigin();
        this.scope?.abort?.();
        if (this._fleetPollTimer) {
            clearInterval(this._fleetPollTimer);
            this._fleetPollTimer = null;
        }
        if (this.syncManager?.pollInterval) {
            clearInterval(this.syncManager.pollInterval);
            this.syncManager.pollInterval = null;
        }
        if (prevProfileId) {
            const prevStore = backendStores.get(prevProfileId);
            this.tabManager?.captureBackendState?.(prevStore);
            if (this.sessionsManager?.activeCWD) {
                prevStore.activeCwd = this.sessionsManager.activeCWD;
            }
        }
        notifications.endContext();
        this.tabManager?.detachAll?.({
            flushBackendId: prevProfileId || undefined,
        });
        const settingsClose = document.querySelector(
            '.settings-overlay .modal-close-btn',
        );
        if (settingsClose) settingsClose.click();
        else document.querySelector('.settings-overlay')?.remove();
        this.sessionsManager?.closeWorkspaceModal?.();
        this.markdownManager?.closeModal?.();
        this.markdownManager?.closeViewer?.();
        this.markdownManager?.closeDiagModal?.();
        this.kanbanManager?.cleanup?.();
        document
            .getElementById('sidebar-panel')
            ?.classList.remove('drawer-open');
        this.tabManager?._closeSelfHudNow?.();
        setServerHostOverride('');
        const fp = document.getElementById('fleet-panel');
        if (fp) fp.style.display = 'none';

        setEmbeddedBackend(profileId, origin || '');
        if (typeof window !== 'undefined' && window.history?.replaceState) {
            window.history.replaceState(
                null,
                '',
                `?desktop=1&embedded=1&profile=${encodeURIComponent(profileId)}&origin=${encodeURIComponent(origin || '')}`,
            );
        }
        const scope = new BackendScope(profileId, origin || '');
        this.scope = scope;
        this.initAppearance();
        this.tabManager?._bindThinkingPresetStore?.(scope);
        const nextStore = backendStores.get(profileId);
        notifications.setContext(serverKey('phi_notifications_v1'), nextStore);
        const targetNotificationContext = notifications.getContextIdentity();
        termPerfMeasureBetween('switch-prep', phaseStart);
        phaseStart = globalThis.performance?.now?.();
        try {
            this.sessionsManager?.resetSessionRootForBackendSwitch?.();
            this.paintBackendFromStore(nextStore);
            // The right panel survives an in-page switch as persistent DOM;
            // reset its backend-scoped surfaces (stream socket, commit list,
            // markdown/files/cmds lists) from the new store's cache. No
            // fetches here: they route by the ACTIVE backend until the
            // /__phi/active POST below lands. A blank previous id is first
            // boot, not a switch, so its panel has no old backend to clear.
            if (
                prevProfileId &&
                (prevProfileId !== profileId ||
                    prevOrigin !== (origin || ''))
            )
                this.diffController?.onBackendSwitch?.();
        } finally {
            termPerfMeasureBetween('switch-paint', phaseStart);
        }
        if (typeof document !== 'undefined' && document.documentElement) {
            document.documentElement.dataset.sync = 'stale';
        }
        if (seq !== this._switchSeq || scope.aborted) return true;

        const activePostStart = globalThis.performance?.now?.();
        const restoreInert = inertBodyExceptNotifications();
        let response;
        try {
            response = await fetch('/__phi/active', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ profileId }),
            });
        } catch {} finally {
            restoreInert();
            termPerfMeasureBetween('switch-active-post', activePostStart);
        }
        if (
            response?.ok === true &&
            seq === this._switchSeq &&
            this.scope === scope &&
            !scope.aborted &&
            notifications.isCurrentContext(targetNotificationContext)
        ) {
            notifications.setActionsBlocked(false);
        }
        if (seq !== this._switchSeq || scope.aborted) return true;
        // The cached paint above IS the switch: it is already on screen.
        // The server refresh runs behind it and overrides the cache when it
        // answers. The switch resolves now, so the shell never waits a
        // remote round trip (and never falls back to a page reload) for
        // fresh data. A superseded switch aborts its own scope, and the
        // background refresh stops at its next await boundary.
        void this.revalidate(scope).catch(() => {});
        return true;
    }

    forgetBackend(profileId) {
        if (!profileId) return true;
        if (profileId === getEmbeddedProfileId()) {
            this.getNotifications().clearCurrentContext();
        }
        this.sessionsManager?.invalidateFeatureCache?.(profileId);
        backendStores.delete(profileId);
        try {
            if (typeof localStorage === 'undefined') return true;
            const suffix = `:${profileId}`;
            const keysToRemove = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && !k.startsWith('phi_session_cache_v1:') && k.endsWith(suffix)) keysToRemove.push(k);
            }
            for (const k of keysToRemove) localStorage.removeItem(k);
        } catch {
            console.warn('[backend] Browser storage cleanup was not confirmed.');
        }
        return true;
    }

    setupMobileGestures() {
        let touchStartX = 0;
        let touchStartY = 0;
        const sidebar = document.getElementById('sidebar-panel');
        const diffPanel = document.getElementById('diff-panel');
        const threshold = 60; // minimum distance in px to register a swipe

        document.addEventListener(
            'touchstart',
            (e) => {
                if (this._isDraggingDrawer) return;
                if (e.target?.closest?.('.notifications-overlay')) return;
                if (e.target?.closest?.('.drawer-resize-handle')) return;
                // Drawer topology is content-first: sessions yields below
                // 1024px, diff below 1280px, plus the compact layout.
                if (!isSidebarDrawerViewport() && !isDiffDrawerViewport()) {
                    return;
                }
                touchStartX = e.touches[0].clientX;
                touchStartY = e.touches[0].clientY;
            },
            { passive: true },
        );

        document.addEventListener(
            'touchend',
            (e) => {
                if (this._isDraggingDrawer) return;
                if (e.target?.closest?.('.notifications-overlay')) return;
                if (e.target?.closest?.('.drawer-resize-handle')) return;
                const sidebarDrawer = isSidebarDrawerViewport();
                const diffDrawer = isDiffDrawerViewport();
                if (!sidebarDrawer && !diffDrawer) return;
                const touchEndX = e.changedTouches[0].clientX;
                const touchEndY = e.changedTouches[0].clientY;

                const diffX = touchEndX - touchStartX;
                const diffY = touchEndY - touchStartY;

                // xterm can consume the click generated by a touch, so close
                // the drawer on a tap without interfering with terminal scroll.
                if (
                    sidebarDrawer &&
                    sidebar?.classList.contains('drawer-open') &&
                    e.target?.closest?.('.terminal-content') &&
                    Math.abs(diffX) < 10 &&
                    Math.abs(diffY) < 10
                ) {
                    sidebar.classList.remove('drawer-open');
                    return;
                }

                if (
                    Math.abs(diffX) > Math.abs(diffY) &&
                    Math.abs(diffX) > threshold
                ) {
                    if (diffX > 0) {
                        // Swipe Right
                        if (sidebarDrawer && touchStartX < 40) {
                            // Swipe from left edge -> Open Sessions drawer
                            sidebar?.classList.add('drawer-open');
                            this.setDrawerMode('tabs');
                            // The brand-anchored HUD would float above it.
                            this.tabManager?._closeSelfHudNow?.();
                        } else if (
                            diffDrawer &&
                            diffPanel &&
                            !diffPanel.classList.contains('hidden')
                        ) {
                            // Swipe right inside panel -> Close Diff drawer
                            this.diffController?.togglePanel(false);
                        }
                    } else {
                        // Swipe Left
                        if (
                            diffDrawer &&
                            window.innerWidth - touchStartX < 40
                        ) {
                            // Swipe from right edge -> Open Diff drawer
                            this.diffController?.togglePanel(true);
                        } else if (
                            sidebarDrawer &&
                            sidebar?.classList.contains('drawer-open')
                        ) {
                            // Swipe left inside sidebar -> Close Sessions drawer
                            sidebar.classList.remove('drawer-open');
                        }
                    }
                }
            },
            { passive: true },
        );
    }

    async fetchCoderPresets(scope) {
        if (scope?.aborted) return;
        try {
            const store = this.getActiveStore?.();
            if (store && typeof store.load === 'function') {
                await store.load('/api/coders', scope, (data) => {
                    rebuildRegistry(data);
                    const coders = listCoders();
                    this.codersPresetRegistry = Object.fromEntries(
                        coders.map((coder) => [coder.id, coder]),
                    );
                });
            } else {
                await loadCoderRegistry(true);
                if (scope?.aborted) return;
                const coders = listCoders();
                this.codersPresetRegistry = Object.fromEntries(
                    coders.map((coder) => [coder.id, coder]),
                );
            }
            const coders = listCoders();
            console.log(
                `[app] Loaded coder registries (${coders.length}):`,
                coders.map((coder) => coder.id),
            );
        } catch (e) {
            if (e?.name === 'AbortError' || scope?.aborted) return;
            console.error('[app] Failed to fetch coder presets:', e);
        }
    }

    readPanelWidthPreference(key) {
        this._panelWidthPreferences ??= new Map();
        if (this._panelWidthPreferences.has(key)) {
            return this._panelWidthPreferences.get(key);
        }
        try {
            const value =
                typeof localStorage !== 'undefined'
                    ? localStorage.getItem(key)
                    : null;
            if (value !== null) this._panelWidthPreferences.set(key, value);
            return value;
        } catch {
            return null;
        }
    }

    writePanelWidthPreference(key, width) {
        this._panelWidthPreferences ??= new Map();
        const value = String(width);
        this._panelWidthPreferences.set(key, value);
        try {
            if (typeof localStorage !== 'undefined') {
                localStorage.setItem(key, value);
            }
        } catch {
            // Panel resizing stays usable when browser storage is blocked.
        }
    }

    adjustLeftPanelWidth(delta) {
        const sidebar = document.getElementById('sidebar-panel');
        if (!sidebar) return;

        if (isSidebarDrawerViewport()) {
            const currentWidth =
                parseFloat(sidebar.style.width) ||
                sidebar.getBoundingClientRect().width ||
                280;
            const minWidth = 160;
            const maxWidth = Math.max(
                minWidth,
                typeof window !== 'undefined' ? window.innerWidth - 24 : 500,
            );
            const clamped = Math.max(
                minWidth,
                Math.min(currentWidth + delta, maxWidth),
            );
            sidebar.style.setProperty('width', `${clamped}px`, 'important');
            this.writePanelWidthPreference('phi_drawer_left_width', clamped);
            if (clamped < 120) {
                sidebar.classList.add('sidebar-narrow');
            } else {
                sidebar.classList.remove('sidebar-narrow');
            }
            return;
        }

        const currentWidth =
            parseFloat(sidebar.style.width) ||
            sidebar.getBoundingClientRect().width ||
            260;
        const targetWidth = currentWidth + delta;
        const clamped = clampPanelWidth(targetWidth, SIDEBAR_PANEL_CAP);

        sidebar.style.removeProperty('width');
        sidebar.style.width = `${clamped}px`;
        this.writePanelWidthPreference('phi_panel_left_width', clamped);

        if (clamped < 120) {
            sidebar.classList.add('sidebar-narrow');
        } else {
            sidebar.classList.remove('sidebar-narrow');
        }

        if (this.tabManager) {
            this.tabManager.startResize();
            this.tabManager.fitActiveTerminal();
            this.tabManager.endResize();
        }
    }

    adjustRightPanelWidth(delta) {
        const diffPanel = document.getElementById('diff-panel');
        if (!diffPanel) return;

        if (isDiffDrawerViewport()) {
            const currentWidth =
                parseFloat(diffPanel.style.width) ||
                diffPanel.getBoundingClientRect().width ||
                320;
            const minWidth = 200;
            const maxWidth = Math.max(
                minWidth,
                typeof window !== 'undefined' ? window.innerWidth - 24 : 600,
            );
            const clamped = Math.max(
                minWidth,
                Math.min(currentWidth + delta, maxWidth),
            );
            diffPanel.style.setProperty('width', `${clamped}px`, 'important');
            this.writePanelWidthPreference('phi_drawer_right_width', clamped);
            return;
        }

        const currentWidth =
            parseFloat(diffPanel.style.width) ||
            diffPanel.getBoundingClientRect().width ||
            340;
        const targetWidth = currentWidth + delta;
        const clamped = clampPanelWidth(targetWidth, DIFF_PANEL_CAP);

        diffPanel.style.removeProperty('width');
        diffPanel.style.width = `${clamped}px`;
        this.writePanelWidthPreference('phi_panel_right_width', clamped);

        if (this.tabManager) {
            this.tabManager.startResize();
            this.tabManager.fitActiveTerminal();
            this.tabManager.endResize();
        }
        if (this.diffController) {
            this.diffController.fitTerminal();
        }
    }

    handlePanelResizeShortcut(e) {
        if (e.defaultPrevented) return false;
        // Require Ctrl+Alt (Option on macOS, Alt on Win/Linux) without Cmd (metaKey),
        // so it never conflicts with macOS Cmd shortcuts, zoom, or browser tab operations.
        if (!e.ctrlKey || !e.altKey || e.metaKey) return false;

        const step = 24;

        // Left panel (Sessions): [ narrows, ] widens
        if (e.key === '[' || e.key === '{' || e.code === 'BracketLeft') {
            e.preventDefault();
            this.adjustLeftPanelWidth(-step);
            return true;
        }
        if (e.key === ']' || e.key === '}' || e.code === 'BracketRight') {
            e.preventDefault();
            this.adjustLeftPanelWidth(step);
            return true;
        }

        // Right panel (Diff/Cmd): - narrows, =/+ widens
        if (e.key === '-' || e.key === '_' || e.code === 'Minus') {
            e.preventDefault();
            this.adjustRightPanelWidth(-step);
            return true;
        }
        if (e.key === '=' || e.key === '+' || e.code === 'Equal') {
            e.preventDefault();
            this.adjustRightPanelWidth(step);
            return true;
        }

        return false;
    }

    initGlobalShortcuts() {
        document.addEventListener('keydown', (e) => {
            if (this.handlePanelResizeShortcut(e)) {
                return;
            }
            if (this.tabManager?.handleInputToggleShortcut?.(e)) {
                return;
            }
            // Ctrl+Shift+D = diag panel. Matches the existing Ctrl+Shift+F
            // search and Ctrl+P pattern (terminal.js handles terminal ones).
            if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
                e.preventDefault();
                if (
                    this.markdownManager &&
                    typeof this.markdownManager.openDiagModal === 'function'
                ) {
                    this.markdownManager.openDiagModal();
                }
            }
        });
    }

    // Drawer mode: the left drawer shows the grouped tab tree by default and
    // the sessions block on demand. The mode CSS exists only inside the
    // compact viewport query, so anywhere else the drawer keeps its native
    // sessions content (it is still a drawer from 769-1023px).
    // The single entry point for opening the compact drawer on its tab tree:
    // the hamburger, the brand and a left-edge swipe all land here.
    openReadyTabs() {
        this.getNotifications().close({ restoreFocus: false });
        if (isCompactViewport()) {
            this.openTabsDrawer();
            return;
        }
        const tabManager = this.tabManager;
        if (!tabManager) return;
        if (tabManager._overflowDropdownHidden?.()) {
            tabManager._toggleOverflowDropdown?.();
            return;
        }
        const dropdown = document.getElementById('tab-overflow-dropdown');
        if (dropdown) tabManager._focusOverflowDropdownOnOpen?.(dropdown);
    }

    removeReadyPane(paneId) {
        this.getNotifications().removeReadyPane(paneId);
    }

    openTabsDrawer() {
        const sidebar = document.getElementById('sidebar-panel');
        if (!sidebar) return;
        sidebar.classList.add('drawer-open');
        this.setDrawerMode('tabs');
        // An open HUD floats above the slide-out (z-index), so opening the
        // drawer dismisses it.
        this.tabManager?._closeSelfHudNow?.();
    }

    setDrawerMode(mode) {
        if (!isCompactViewport()) mode = 'sessions';
        const sidebar = document.getElementById('sidebar-panel');
        if (!sidebar) return;
        // Cached pre-drawer markup has no tab body: the mode rules would hide
        // the sessions controls and the builder would render nothing.
        if (mode === 'tabs' && !document.getElementById('drawer-tabs-body'))
            mode = 'sessions';
        sidebar.dataset.panelMode = mode;
        const title = document.getElementById('drawer-panel-title');
        if (title) title.textContent = mode === 'tabs' ? 'TABS' : 'SESSIONS';
        sidebar.setAttribute(
            'aria-label',
            mode === 'tabs' ? 'Tabs' : 'Sessions',
        );
        if (mode === 'tabs') this.tabManager?._buildDrawerTabsBody?.();
    }

    initResizers() {
        const leftHandle = document.getElementById('left-resize-handle');
        const rightHandle = document.getElementById('right-resize-handle');
        const sidebar = document.getElementById('sidebar-panel');
        const diffPanel = document.getElementById('diff-panel');

        // Inject dedicated drawer touch resizers if not already in DOM
        let leftDrawerHandle = document.getElementById(
            'sidebar-drawer-resizer',
        );
        if (!leftDrawerHandle && sidebar) {
            leftDrawerHandle = document.createElement('div');
            leftDrawerHandle.id = 'sidebar-drawer-resizer';
            leftDrawerHandle.className =
                'drawer-resize-handle drawer-resize-left';
            leftDrawerHandle.setAttribute('aria-hidden', 'true');
            sidebar.appendChild(leftDrawerHandle);
        }

        let rightDrawerHandle = document.getElementById('diff-drawer-resizer');
        if (!rightDrawerHandle && diffPanel) {
            rightDrawerHandle = document.createElement('div');
            rightDrawerHandle.id = 'diff-drawer-resizer';
            rightDrawerHandle.className =
                'drawer-resize-handle drawer-resize-right';
            rightDrawerHandle.setAttribute('aria-hidden', 'true');
            diffPanel.appendChild(rightDrawerHandle);
        }

        const applyResponsivePanelWidths = () => {
            if (!sidebar || !diffPanel) return;

            // Left panel: drawer vs docked
            if (isSidebarDrawerViewport()) {
                const savedDrawerLeft = this.readPanelWidthPreference(
                    'phi_drawer_left_width',
                );
                if (savedDrawerLeft) {
                    const w = parseFloat(savedDrawerLeft);
                    const maxW = Math.max(160, window.innerWidth - 24);
                    if (!Number.isNaN(w) && w >= 160) {
                        sidebar.style.setProperty(
                            'width',
                            `${Math.min(w, maxW)}px`,
                            'important',
                        );
                    }
                }
            } else {
                sidebar.style.removeProperty('width');
                const savedLeftWidth = this.readPanelWidthPreference(
                    'phi_panel_left_width',
                );
                if (savedLeftWidth) {
                    const widthNum = parseFloat(savedLeftWidth);
                    sidebar.style.width = `${clampPanelWidth(
                        widthNum,
                        SIDEBAR_PANEL_CAP,
                    )}px`;
                    if (widthNum < 120) {
                        sidebar.classList.add('sidebar-narrow');
                    } else {
                        sidebar.classList.remove('sidebar-narrow');
                    }
                }
            }

            // Right panel: drawer vs docked
            if (isDiffDrawerViewport()) {
                const savedDrawerRight = this.readPanelWidthPreference(
                    'phi_drawer_right_width',
                );
                if (savedDrawerRight) {
                    const w = parseFloat(savedDrawerRight);
                    const maxW = Math.max(200, window.innerWidth - 24);
                    if (!Number.isNaN(w) && w >= 200) {
                        diffPanel.style.setProperty(
                            'width',
                            `${Math.min(w, maxW)}px`,
                            'important',
                        );
                    }
                }
            } else {
                diffPanel.style.removeProperty('width');
                const savedRightWidth = this.readPanelWidthPreference(
                    'phi_panel_right_width',
                );
                if (savedRightWidth) {
                    diffPanel.style.width = `${clampPanelWidth(
                        parseFloat(savedRightWidth),
                        DIFF_PANEL_CAP,
                    )}px`;
                }
            }
        };

        applyResponsivePanelWidths();
        window.addEventListener('resize', applyResponsivePanelWidths);

        let activeResize = false;
        const hasPointer =
            typeof window !== 'undefined' && 'PointerEvent' in window;
        const startEvt = hasPointer ? 'pointerdown' : 'mousedown';
        const acceptsStart = (e) =>
            !activeResize &&
            (hasPointer
                ? e.isPrimary && e.button === 0
                : e.button === 0);
        const ownsPointer = (e, pointerId) =>
            !hasPointer || e.pointerId === pointerId;
        const moveEvt = hasPointer ? 'pointermove' : 'mousemove';
        const endEvt = hasPointer ? 'pointerup' : 'mouseup';
        let drawerResetTimer = null;
        const beginDrawerResize = () => {
            if (drawerResetTimer !== null) clearTimeout(drawerResetTimer);
            drawerResetTimer = null;
            this._isDraggingDrawer = true;
        };
        const endDrawerResize = () => {
            drawerResetTimer = setTimeout(() => {
                drawerResetTimer = null;
                this._isDraggingDrawer = false;
            }, 50);
        };

        // Desktop Left resizing handler
        if (leftHandle && sidebar) {
            leftHandle.addEventListener(startEvt, (e) => {
                if (!acceptsStart(e)) return;
                activeResize = true;
                const pointerId = hasPointer ? e.pointerId : null;
                const startX = e.clientX;
                const startWidth = sidebar.getBoundingClientRect().width;
                e.preventDefault();
                leftHandle.classList.add('dragging');
                document.body.style.cursor = 'col-resize';
                if (leftHandle.setPointerCapture && pointerId != null) {
                    try {
                        leftHandle.setPointerCapture(pointerId);
                    } catch (_) {}
                }
                this.tabManager?.startResize();

                const doDrag = (moveEvent) => {
                    if (!ownsPointer(moveEvent, pointerId)) return;
                    const width = startWidth + moveEvent.clientX - startX;
                    const capPx = clampPanelWidth(
                        SIDEBAR_PANEL_CAP.max,
                        SIDEBAR_PANEL_CAP,
                    );
                    if (width > SIDEBAR_PANEL_CAP.min && width < capPx) {
                        sidebar.style.removeProperty('width');
                        sidebar.style.width = `${width}px`;
                        this.writePanelWidthPreference(
                            'phi_panel_left_width',
                            width,
                        );

                        if (width < 120) {
                            sidebar.classList.add('sidebar-narrow');
                        } else {
                            sidebar.classList.remove('sidebar-narrow');
                        }

                        this.tabManager?.fitActiveTerminal();
                    }
                };

                const finishDrag = (event) => {
                    if (!ownsPointer(event, pointerId)) return;
                    document.removeEventListener(moveEvt, doDrag);
                    document.removeEventListener(endEvt, finishDrag);
                    if (hasPointer) {
                        document.removeEventListener(
                            'pointercancel',
                            cancelDrag,
                        );
                    }
                    leftHandle.classList.remove('dragging');
                    document.body.style.cursor = '';
                    if (leftHandle.releasePointerCapture && pointerId != null) {
                        try {
                            leftHandle.releasePointerCapture(pointerId);
                        } catch (_) {}
                    }
                    activeResize = false;
                    try {
                        this.tabManager?.fitActiveTerminal();
                    } finally {
                        this.tabManager?.endResize();
                    }
                };
                const cancelDrag = (event) => finishDrag(event);

                document.addEventListener(moveEvt, doDrag);
                document.addEventListener(endEvt, finishDrag);
                if (hasPointer) {
                    document.addEventListener('pointercancel', cancelDrag);
                }
            });
        }

        // Desktop Right resizing handler
        if (rightHandle && diffPanel) {
            rightHandle.addEventListener(startEvt, (e) => {
                if (!acceptsStart(e)) return;
                activeResize = true;
                const pointerId = hasPointer ? e.pointerId : null;
                const startX = e.clientX;
                const startWidth = diffPanel.getBoundingClientRect().width;
                e.preventDefault();
                rightHandle.classList.add('dragging');
                document.body.style.cursor = 'col-resize';
                if (rightHandle.setPointerCapture && pointerId != null) {
                    try {
                        rightHandle.setPointerCapture(pointerId);
                    } catch (_) {}
                }
                this.tabManager?.startResize();

                const doDrag = (moveEvent) => {
                    if (!ownsPointer(moveEvent, pointerId)) return;
                    const width = startWidth - (moveEvent.clientX - startX);
                    const capPx = clampPanelWidth(
                        DIFF_PANEL_CAP.max,
                        DIFF_PANEL_CAP,
                    );
                    if (width > DIFF_PANEL_CAP.min && width < capPx) {
                        diffPanel.style.removeProperty('width');
                        diffPanel.style.width = `${width}px`;
                        this.writePanelWidthPreference(
                            'phi_panel_right_width',
                            width,
                        );
                        this.tabManager?.fitActiveTerminal();
                        this.diffController?.fitTerminal();
                    }
                };

                const finishDrag = (event) => {
                    if (!ownsPointer(event, pointerId)) return;
                    document.removeEventListener(moveEvt, doDrag);
                    document.removeEventListener(endEvt, finishDrag);
                    if (hasPointer) {
                        document.removeEventListener(
                            'pointercancel',
                            cancelDrag,
                        );
                    }
                    rightHandle.classList.remove('dragging');
                    document.body.style.cursor = '';
                    if (rightHandle.releasePointerCapture && pointerId != null) {
                        try {
                            rightHandle.releasePointerCapture(pointerId);
                        } catch (_) {}
                    }
                    activeResize = false;
                    try {
                        this.tabManager?.fitActiveTerminal();
                    } finally {
                        try {
                            this.diffController?.fitTerminal();
                        } finally {
                            this.tabManager?.endResize();
                        }
                    }
                };
                const cancelDrag = (event) => finishDrag(event);

                document.addEventListener(moveEvt, doDrag);
                document.addEventListener(endEvt, finishDrag);
                if (hasPointer) {
                    document.addEventListener('pointercancel', cancelDrag);
                }
            });
        }

        // Mobile / Drawer Left resizing handler
        if (leftDrawerHandle && sidebar) {
            leftDrawerHandle.addEventListener(startEvt, (e) => {
                if (!acceptsStart(e)) return;
                activeResize = true;
                beginDrawerResize();
                const pointerId = hasPointer ? e.pointerId : null;
                const startX = e.clientX;
                const startWidth = sidebar.getBoundingClientRect().width;
                let acceptedWidth = startWidth;
                let previewing = false;
                e.preventDefault();
                e.stopPropagation();
                leftDrawerHandle.classList.add('dragging');
                sidebar.classList.add('resizing');

                if (leftDrawerHandle.setPointerCapture && pointerId != null) {
                    try {
                        leftDrawerHandle.setPointerCapture(pointerId);
                    } catch (_) {}
                }

                const restoreAcceptedWidth = () => {
                    sidebar.style.setProperty(
                        'width',
                        `${acceptedWidth}px`,
                        'important',
                    );
                    sidebar.classList.toggle('sidebar-narrow', acceptedWidth < 120);
                };
                const doDrag = (moveEvent) => {
                    if (!ownsPointer(moveEvent, pointerId)) return;
                    const minWidth = 160;
                    const maxWidth = Math.max(minWidth, window.innerWidth - 24);
                    if (moveEvent.clientX < 100) {
                        previewing = true;
                        sidebar.style.setProperty('width', `${minWidth}px`, 'important');
                        sidebar.classList.add('sidebar-narrow');
                        return;
                    }
                    previewing = false;
                    const newWidth = Math.max(
                        minWidth,
                        Math.min(
                            startWidth + moveEvent.clientX - startX,
                            maxWidth,
                        ),
                    );
                    acceptedWidth = newWidth;
                    sidebar.style.setProperty('width', `${newWidth}px`, 'important');
                    this.writePanelWidthPreference('phi_drawer_left_width', newWidth);
                    sidebar.classList.toggle('sidebar-narrow', newWidth < 120);
                };

                const cleanup = () => {
                    document.removeEventListener(moveEvt, doDrag);
                    document.removeEventListener(endEvt, finishDrag);
                    if (hasPointer) {
                        document.removeEventListener('pointercancel', cancelDrag);
                    }
                    leftDrawerHandle.classList.remove('dragging');
                    sidebar.classList.remove('resizing');
                    if (leftDrawerHandle.releasePointerCapture && pointerId != null) {
                        try {
                            leftDrawerHandle.releasePointerCapture(pointerId);
                        } catch (_) {}
                    }
                    activeResize = false;
                    endDrawerResize();
                };
                const finishDrag = (upEvent) => {
                    if (!ownsPointer(upEvent, pointerId)) return;
                    const dismiss = upEvent.clientX < 100;
                    cleanup();
                    if (dismiss) {
                        sidebar.classList.remove('drawer-open');
                        restoreAcceptedWidth();
                    } else if (previewing) {
                        restoreAcceptedWidth();
                    }
                };
                const cancelDrag = (event) => {
                    if (!ownsPointer(event, pointerId)) return;
                    cleanup();
                    restoreAcceptedWidth();
                };

                document.addEventListener(moveEvt, doDrag);
                document.addEventListener(endEvt, finishDrag);
                if (hasPointer) {
                    document.addEventListener('pointercancel', cancelDrag);
                }
            });
        }

        // Mobile / Drawer Right resizing handler
        if (rightDrawerHandle && diffPanel) {
            rightDrawerHandle.addEventListener(startEvt, (e) => {
                if (!acceptsStart(e)) return;
                activeResize = true;
                beginDrawerResize();
                const pointerId = hasPointer ? e.pointerId : null;
                const startX = e.clientX;
                const startWidth = diffPanel.getBoundingClientRect().width;
                let acceptedWidth = startWidth;
                let previewing = false;
                e.preventDefault();
                e.stopPropagation();
                rightDrawerHandle.classList.add('dragging');
                diffPanel.classList.add('resizing');

                if (rightDrawerHandle.setPointerCapture && pointerId != null) {
                    try {
                        rightDrawerHandle.setPointerCapture(pointerId);
                    } catch (_) {}
                }

                const restoreAcceptedWidth = () => {
                    diffPanel.style.setProperty(
                        'width',
                        `${acceptedWidth}px`,
                        'important',
                    );
                };
                const doDrag = (moveEvent) => {
                    if (!ownsPointer(moveEvent, pointerId)) return;
                    const minWidth = 200;
                    const maxWidth = Math.max(minWidth, window.innerWidth - 24);
                    if (window.innerWidth - moveEvent.clientX < 120) {
                        previewing = true;
                        diffPanel.style.setProperty('width', `${minWidth}px`, 'important');
                        return;
                    }
                    previewing = false;
                    const newWidth = Math.max(
                        minWidth,
                        Math.min(
                            startWidth - (moveEvent.clientX - startX),
                            maxWidth,
                        ),
                    );
                    acceptedWidth = newWidth;
                    diffPanel.style.setProperty('width', `${newWidth}px`, 'important');
                    this.writePanelWidthPreference('phi_drawer_right_width', newWidth);
                };

                const cleanup = () => {
                    document.removeEventListener(moveEvt, doDrag);
                    document.removeEventListener(endEvt, finishDrag);
                    if (hasPointer) {
                        document.removeEventListener('pointercancel', cancelDrag);
                    }
                    rightDrawerHandle.classList.remove('dragging');
                    diffPanel.classList.remove('resizing');
                    if (rightDrawerHandle.releasePointerCapture && pointerId != null) {
                        try {
                            rightDrawerHandle.releasePointerCapture(pointerId);
                        } catch (_) {}
                    }
                    activeResize = false;
                    endDrawerResize();
                };
                const finishDrag = (upEvent) => {
                    if (!ownsPointer(upEvent, pointerId)) return;
                    const dismiss = window.innerWidth - upEvent.clientX < 120;
                    cleanup();
                    if (dismiss) {
                        try {
                            this.diffController?.togglePanel(false);
                        } finally {
                            restoreAcceptedWidth();
                        }
                    } else if (previewing) {
                        restoreAcceptedWidth();
                    }
                };
                const cancelDrag = (event) => {
                    if (!ownsPointer(event, pointerId)) return;
                    cleanup();
                    restoreAcceptedWidth();
                };

                document.addEventListener(moveEvt, doDrag);
                document.addEventListener(endEvt, finishDrag);
                if (hasPointer) {
                    document.addEventListener('pointercancel', cancelDrag);
                }
            });
        }
    }

    applyAccentTheme(colorKey) {
        const theme = applyThemeTokens(colorKey);
        localStorage.setItem(serverKey('phi_theme_color'), colorKey);

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
        const faviconAccent =
            this.faviconAccent || styles.getPropertyValue('--accent').trim();
        const faviconAccentDim =
            this.faviconAccentDim ||
            styles.getPropertyValue('--accent-dim').trim();

        // Remove all existing icon links to force Safari to clear its cache hook for the node.
        const links = document.querySelectorAll("link[rel~='icon']");
        links.forEach((l) => {
            l.remove();
        });

        const link = document.createElement('link');
        link.rel = 'icon';
        link.type = 'image/svg+xml';

        const svg = buildPhiFaviconSvg(
            faviconAccent,
            faviconAccentDim,
            this.terminalActivity,
        );

        link.href = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
        document.getElementsByTagName('head')[0].appendChild(link);
    }

    async saveTheme(colorKey) {
        try {
            const request = this.authContext?.fetch || fetch;
            const response = await request('/api/config/theme', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ color: colorKey }),
            });
            await response.text();
        } catch (e) {
            console.error('[theme] Failed to save theme:', e);
        }
    }

    // applyFastMode computes the effects profile. The preference is
    // browser-stored (localStorage `phi_low_power`) — GPU burn is a
    // property of this machine, not of the server being viewed — with the
    // legacy per-server `config.fast_mode` kept only as a one-time
    // migration source (see resolveLowPowerEnabled). The profile is
    // forced on for mobile, where the animations and blurs cost the most
    // (see research/2026-08-01-2138-mobile-is-fast-mode.md).
    // Single writer of the body class; never toggle it directly elsewhere.
    // matchMedia guard: jsdom (tests) has no matchMedia — treat as not
    // mobile, same idiom as the isTouch check in terminal.js.
    applyFastMode() {
        const mobile =
            typeof window.matchMedia === 'function' &&
            window.matchMedia(COMPACT_VIEWPORT_QUERY).matches;
        // Third input: the browser's own mobile flag. Catches massive
        // tablets that are geometrically indistinguishable from desktops.
        // Chromium-only — Safari/Firefox report undefined, which is falsy,
        // so unsupported browsers fall back to the geometry/config logic.
        const deviceMobile =
            typeof navigator !== 'undefined' &&
            navigator.userAgentData?.mobile === true;
        const on =
            resolveLowPowerEnabled(!!this.config?.fast_mode) ||
            mobile ||
            deviceMobile;
        document.body.classList.toggle('fast-mode', on);
    }

    // setLowPowerMode is the single writer of the browser preference:
    // persists to localStorage, mirrors in-memory onto config.fast_mode
    // (read-only compat for old readers — never POSTed to the server),
    // re-applies the body class, and notifies same-origin tabs. On
    // phi-desktop the tray fan-out writes this same key into every
    // retained server view, so the tray checkbox is the one global
    // switch; this method covers the in-page settings toggle.
    setLowPowerMode(enabled) {
        writeLowPowerLocal(enabled);
        if (this.config) this.config.fast_mode = enabled;
        this.applyFastMode();
        broadcastConfigSync('low-power', { enabled });
    }

    openSettingsModal(opts) {
        openSettingsModal(this, ACCENT_COLORS, opts);
    }

    initAppearance(data = {}) {
        this.settingsReady = Object.keys(data).length > 0;
        this.mobileAppearanceStore?.dispose();
        this.scope ||= captureAppearanceScope();
        this.authContext = appearanceRequestContext(this.scope);
        this.desktopAppearance = null;
        const store = new MobileAppearanceStore(this.scope);
        this.mobileAppearanceStore = store;
        this.ingestAppearance(data);
        store.subscribe(() => {
            if (this.mobileAppearanceStore === store) this.applyAppearanceProfile();
        });
        this.applyAppearanceProfile();
        void store.start();
    }

    ingestAppearance(data) {
        // Only authorized server fields seed mobile inheritance, before desktop cache precedence.
        this.mobileAppearanceStore?.ingestInheritance(data);
        const ls = readDesktopAppearance(this.scope || captureAppearanceScope());
        this.desktopAppearance = {
            ui_font_family: ls.ui_font_family ?? data.ui_font_family ?? '',
            ui_font_size: Number(ls.ui_font_size ?? data.ui_font_size) || 0,
            terminal_font_family: ls.terminal_font_family ?? data.terminal_font_family ?? '',
            terminal_font_size: Number(ls.terminal_font_size ?? data.terminal_font_size) || 0,
        };
        this.mobileScrollbackRows = Number(ls.mobile_scrollback_rows ?? data.mobile_scrollback_rows) || 0;
        this.hostnameOverride = ls.hostname_override ?? data.hostname_override ?? '';
        setServerHostOverride(this.hostnameOverride);
        this.customFontName = ls.custom_font_name || '';
        this.terminalBgName = ls.terminal_bg_name || '';
        this.terminalBgDarkness = ls.terminal_bg_darkness ?? 98;
        this.terminalBgBlur = ls.terminal_bg_blur ?? 0;
        this.applyAppearanceProfile();
    }

    applyAppearanceProfile() {
        const profile = currentAppearanceProfile();
        const values = effectiveAppearance(profile, this.desktopAppearance || {}, this.mobileAppearanceStore?.values || EMPTY_MOBILE, this.mobileAppearanceStore?.inheritance || {});
        const previousFamily = this.terminalFontFamily, previousSize = this.terminalFontSize;
        this.uiFontFamily = values.ui_font_family;
        this.uiFontSize = values.ui_font_size;
        this.terminalFontFamily = values.terminal_font_family;
        this.terminalFontSize = values.terminal_font_size;
        this.applyUIFont();
        if (previousFamily !== this.terminalFontFamily) this.tabManager?.applyFontToAllActiveTerminals?.(this.terminalFontFamily || 'JetBrains Mono, monospace');
        if (previousSize !== this.terminalFontSize) this.tabManager?.applyTerminalFontSizeToAll?.(this.terminalFontSize);
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

    // _saveAppearanceLocal write-throughs the current appearance fields
    // to localStorage so they survive a server config reset (browser is
    // authoritative; server is the secondary mirror). Mirrors the
    // phi_theme_color pre-paint precedent.
    _saveAppearanceLocal() {
        if (currentAppearanceProfile() === 'desktop') this.desktopAppearance = {
            ui_font_family: this.uiFontFamily || '', ui_font_size: this.uiFontSize || 0,
            terminal_font_family: this.terminalFontFamily || '', terminal_font_size: this.terminalFontSize || 0,
        };
        try {
            const scope = this.scope || captureAppearanceScope();
            localStorage.setItem(
                legacyAppearanceKey(scope),
                JSON.stringify({
                    ...this.desktopAppearance,
                    // A mobile page owns no desktop fonts. Keep newer values from other documents.
                    ...(currentAppearanceProfile() === 'mobile' ? readDesktopAppearance(scope) : {}),
                    mobile_scrollback_rows: this.mobileScrollbackRows || 0,
                    hostname_override: this.hostnameOverride || '',
                    custom_font_name: this.customFontName || '',
                    terminal_bg_name: this.terminalBgName || '',
                    terminal_bg_darkness:
                        typeof this.terminalBgDarkness === 'number'
                            ? this.terminalBgDarkness
                            : 98,
                    terminal_bg_blur:
                        typeof this.terminalBgBlur === 'number'
                            ? this.terminalBgBlur
                            : 0,
                }),
            );
        } catch (e) {
            console.warn('[appearance] localStorage write failed', e);
        }
    }

    // _db / _putCustomFont / _getCustomFont / _deleteCustomFont —
    // a tiny IndexedDB helper for fonts and terminal background images.
    // IndexedDB (not localStorage) because file bytes can exceed
    // localStorage's ~5MB synchronous string quota; Blobs store natively
    // with no base64 inflation. Local-only: never sent to the server.
    _db() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open('phi', 2);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains('fonts')) {
                    db.createObjectStore('fonts');
                }
                if (!db.objectStoreNames.contains('backgrounds')) {
                    db.createObjectStore('backgrounds');
                }
            };
            req.onsuccess = () => {
                const db = req.result;
                db.onversionchange = () => db.close();
                resolve(db);
            };
            req.onblocked = () => {
                console.warn(
                    '[db] IndexedDB upgrade blocked by another open connection',
                );
            };
            req.onerror = () => reject(req.error);
        });
    }
    _fontDB() {
        return this._db();
    }
    async _putCustomFont(displayName, blob) {
        const db = await this._db();
        await new Promise((res, rej) => {
            const tx = db.transaction('fonts', 'readwrite');
            tx.objectStore('fonts').put({ displayName, blob }, 'custom');
            tx.oncomplete = res;
            tx.onerror = () => rej(tx.error);
        });
    }
    async _getCustomFont() {
        const db = await this._db();
        return new Promise((res, rej) => {
            const tx = db.transaction('fonts', 'readonly');
            const g = tx.objectStore('fonts').get('custom');
            g.onsuccess = () => res(g.result || null);
            g.onerror = () => rej(g.error);
        });
    }
    async _deleteCustomFont() {
        const db = await this._db();
        await new Promise((res, rej) => {
            const tx = db.transaction('fonts', 'readwrite');
            tx.objectStore('fonts').delete('custom');
            tx.oncomplete = res;
            tx.onerror = () => rej(tx.error);
        });
    }

    async _putCustomBg(displayName, blob) {
        const db = await this._db();
        await new Promise((res, rej) => {
            const tx = db.transaction('backgrounds', 'readwrite');
            tx.objectStore('backgrounds').put(
                { displayName, blob },
                'custom_bg',
            );
            tx.oncomplete = res;
            tx.onerror = () => rej(tx.error);
        });
    }
    async _getCustomBg() {
        const db = await this._db();
        return new Promise((res, rej) => {
            const tx = db.transaction('backgrounds', 'readonly');
            const g = tx.objectStore('backgrounds').get('custom_bg');
            g.onsuccess = () => res(g.result || null);
            g.onerror = () => rej(g.error);
        });
    }
    async _deleteCustomBg() {
        const db = await this._db();
        await new Promise((res, rej) => {
            const tx = db.transaction('backgrounds', 'readwrite');
            tx.objectStore('backgrounds').delete('custom_bg');
            tx.oncomplete = res;
            tx.onerror = () => rej(tx.error);
        });
    }

    // applyTerminalBg mounts the chosen background image blob into the DOM
    // via an object URL and updates xterm viewports to transparent.
    applyTerminalBg(blobOrFile) {
        if (!blobOrFile) return;
        if (this._terminalBgObjectUrl) {
            URL.revokeObjectURL(this._terminalBgObjectUrl);
        }
        this._terminalBgObjectUrl = URL.createObjectURL(blobOrFile);
        document.body?.classList.add('has-terminal-bg');
        const bgLayer = document.getElementById('terminal-bg-layer');
        if (bgLayer) {
            bgLayer.style.backgroundImage = `url("${this._terminalBgObjectUrl}")`;
        }
        this.applyTerminalBgStyles();
        this.tabManager?.applyThemeToAllActiveTerminals();
    }

    // applyTerminalBgStyles dynamically adjusts blur and darkness overlay opacity.
    applyTerminalBgStyles() {
        if (
            !this.terminalBgName &&
            !document.body?.classList.contains('has-terminal-bg')
        ) {
            return;
        }
        const bgLayer = document.getElementById('terminal-bg-layer');
        if (bgLayer) {
            const blur =
                typeof this.terminalBgBlur === 'number'
                    ? this.terminalBgBlur
                    : 0;
            bgLayer.style.filter = blur > 0 ? `blur(${blur}px)` : 'none';
        }
        const bgOverlay = document.getElementById('terminal-bg-overlay');
        if (bgOverlay) {
            const darkness =
                (typeof this.terminalBgDarkness === 'number'
                    ? this.terminalBgDarkness
                    : 98) / 100;
            bgOverlay.style.opacity = `${darkness}`;
        }
    }

    // clearCustomBgDOM cleans up background elements, object URLs, and restores xterm themes.
    clearCustomBgDOM() {
        if (this._terminalBgObjectUrl) {
            URL.revokeObjectURL(this._terminalBgObjectUrl);
            this._terminalBgObjectUrl = null;
        }
        document.body?.classList.remove('has-terminal-bg');
        const bgLayer = document.getElementById('terminal-bg-layer');
        if (bgLayer) {
            bgLayer.style.removeProperty('background-image');
            bgLayer.style.removeProperty('filter');
        }
        const bgOverlay = document.getElementById('terminal-bg-overlay');
        if (bgOverlay) {
            bgOverlay.style.removeProperty('opacity');
        }
        this.tabManager?.applyThemeToAllActiveTerminals();
    }

    // loadCustomBg reloads the stored background from IndexedDB on startup.
    async loadCustomBg() {
        if (!this.terminalBgName) {
            this.clearCustomBgDOM();
            return;
        }
        try {
            const rec = await this._getCustomBg();
            if (rec?.blob) {
                this.applyTerminalBg(rec.blob);
            } else {
                this.clearCustomBgDOM();
            }
        } catch (e) {
            console.warn('[bg] load custom failed', e);
            this.clearCustomBgDOM();
        }
    }

    // clearCustomBg removes the stored background image and resets state.
    async clearCustomBg() {
        try {
            await this._deleteCustomBg();
        } catch {}
        this.terminalBgName = '';
        this.clearCustomBgDOM();
        this._saveAppearanceLocal();
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
            "@font-face{font-family:'Phi Custom Font';src:url(" +
            url +
            ');font-display:swap;}';
    }
    // loadCustomFont re-injects the @font-face from IndexedDB on boot.
    // Called from the sessions ingest after customFontName is set.
    async loadCustomFont() {
        if (!this.customFontName && ![this.uiFontFamily, this.terminalFontFamily].some(family => family?.includes('Phi Custom Font'))) return;
        try {
            const rec = await this._getCustomFont();
            if (rec?.blob) this._injectCustomFontFace(rec.blob);
        } catch (e) {
            console.warn('[font] load custom failed', e);
        }
        document.querySelector('.settings-overlay')?.dispatchEvent(new Event('phi-settings-refresh'));
    }
    // clearCustomFont drops the IndexedDB entry + <style> + name, and
    // falls back either surface that was using the custom font.
    async clearCustomFont() {
        try {
            await this._deleteCustomFont();
        } catch {}
        document.getElementById('phi-custom-fonts')?.remove();
        this.customFontName = '';
        if (this.uiFontFamily === 'Phi Custom Font') {
            this.uiFontFamily = '';
            this.applyUIFont();
        }
        if (this.terminalFontFamily === 'Phi Custom Font') {
            this.terminalFontFamily = '';
            this.tabManager?.applyFontToAllActiveTerminals(
                'JetBrains Mono, monospace',
            );
        }
    }

    applyUIFont() {
        applyAppearanceFonts(currentAppearanceProfile(), {
            ui_font_family: this.uiFontFamily || '', ui_font_size: this.uiFontSize || 0,
            terminal_font_family: this.terminalFontFamily || '', terminal_font_size: this.terminalFontSize || 0,
        });
    }

    // Legacy/shared settings retain their endpoint; only edited fields are sent.
    async persistAppearance(fields = {}) {
        if (!Object.keys(fields).length) return;
        const context = this.authContext || appearanceRequestContext(this.scope || captureAppearanceScope());
        try {
            await context.fetch('/api/config/appearance', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(fields),
            });
        } catch (e) {
            console.warn('[appearance] failed to persist:', e);
        }
    }

    initCrossWindowConfigSync() {
        if (typeof BroadcastChannel === 'undefined') return;
        try {
            this._configBroadcastChannel = new BroadcastChannel(
                'phi_config_sync',
            );
            this._configBroadcastChannel.onmessage = async (e) => {
                const msg = e.data;
                if (!msg || typeof msg !== 'object') return;
                if (msg.type !== 'low-power') {
                    const owner = appearanceOwner(this.scope || captureAppearanceScope());
                    if ((msg.owner && msg.owner !== owner) || (!msg.owner && this.scope?.profileId)) return;
                }
                if (msg.type === 'theme' && typeof msg.color === 'string') {
                    this.applyAccentTheme(msg.color);
                    this.tabManager?.applyThemeToAllActiveTerminals?.();
                } else if (msg.type === 'appearance') {
                    const ls = readDesktopAppearance(this.scope || captureAppearanceScope());
                    // Broadcasts are hints, not authoritative server inheritance.
                    this.ingestAppearance({});
                    void this.mobileAppearanceStore?.refreshInheritance();
                    this.mobileScrollbackRows =
                        Number(ls?.mobile_scrollback_rows) || 0;
                    this.hostnameOverride = ls?.hostname_override || '';
                    setServerHostOverride(this.hostnameOverride);
                    this.customFontName = ls?.custom_font_name || '';
                    this.terminalBgName = ls?.terminal_bg_name || '';
                    this.terminalBgDarkness =
                        typeof ls?.terminal_bg_darkness === 'number'
                            ? ls.terminal_bg_darkness
                            : 98;
                    this.terminalBgBlur =
                        typeof ls?.terminal_bg_blur === 'number'
                            ? ls.terminal_bg_blur
                            : 0;
                    this.applyUIFont?.();
                    this.loadCustomBg?.();
                    this.tabManager?.applyFontToAllActiveTerminals?.(
                        this.terminalFontFamily || 'JetBrains Mono, monospace',
                    );
                    this.tabManager?.applyTerminalFontSizeToAll?.(
                        this.terminalFontSize,
                    );
                } else if (msg.type === 'low-power') {
                    // Browser-stored preference changed in a same-origin
                    // tab (or fanned out by the desktop tray): localStorage
                    // is already the new truth, so just re-apply and keep
                    // an open settings checkbox in sync. No server fetch —
                    // the server no longer owns this flag.
                    this.applyFastMode?.();
                    try {
                        const input = document.getElementById(
                            'settings-fast-mode',
                        );
                        if (input && 'checked' in input) {
                            input.checked =
                                typeof msg.enabled === 'boolean'
                                    ? msg.enabled
                                    : document.body.classList.contains(
                                          'fast-mode',
                                      );
                        }
                    } catch {}
                } else if (msg.type === 'behavior') {
                    try {
                        const res = await fetch('/api/config');
                        if (res.ok) {
                            const data = await res.json();
                            this.config = data;
                            this.useExistingTerminalTab =
                                !!data.use_existing_terminal_tab;
                            this.useHiddenTerminal = !!data.use_hidden_terminal;
                            this.applyFastMode?.();
                        }
                    } catch {}
                }
            };
        } catch {}
    }

    /**
     * Show a transient toast notification in the top-right corner.
     * @param {string} message - body text (the precise error/info)
     * @param {object} [opts]
     * @param {'error'|'info'|'success'} [opts.type='info']
     * @param {string} [opts.title] - bold heading; defaults based on type
     * @param {number} [opts.duration=6000] - ms before auto-dismiss; 0 to persist
     */
    getNotifications() {
        if (this.notifications) return this.notifications;
        if (!this._defaultStore) {
            this._defaultStore = new BackendStore('__default__');
        }
        const showToast = (message, opts) => this.showToast(message, opts);
        const manager = new NotificationManager({
            storageKey: serverKey('phi_notifications_v1'),
            store: this.getActiveStore(),
            onReadyTabs: () => this.openReadyTabs(),
            onDestroy: () => {
                if (
                    typeof window !== 'undefined' &&
                    window.__phiShowToast === showToast
                ) {
                    delete window.__phiShowToast;
                }
            },
        });
        this.notifications = manager;
        if (typeof window !== 'undefined') {
            window.__phiShowToast = showToast;
        }
        return manager;
    }

    showToast(message, opts = {}) {
        return this.getNotifications().show(message, opts);
    }

    captureToastContext() {
        return this.getNotifications().captureNotifier();
    }

    dismissToast(element) {
        this.getNotifications().dismissToast(element);
    }

    openConfigEditor({
        title,
        subtitle = '',
        fields = [],
        submitLabel = 'Save',
    }) {
        return new Promise((resolve) => {
            const isPathField = (field) =>
                !field.multiline &&
                (!field.type || field.type === 'text') &&
                field.path !== null &&
                typeof field.path === 'object' &&
                !Array.isArray(field.path);
            const pathFields = fields.filter(isPathField);
            const hasPathFields = pathFields.length > 0;
            const existing = document.querySelector('.config-editor-overlay');
            existing?.querySelector('.modal-close-btn')?.click();

            const opener =
                hasPathFields &&
                document.activeElement instanceof HTMLElement &&
                document.activeElement !== document.body &&
                document.activeElement.isConnected
                    ? document.activeElement
                    : null;

            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay config-editor-overlay hidden';

            const modal = document.createElement('div');
            modal.className = 'modal-content config-editor-modal';
            if (hasPathFields) {
                modal.classList.add('config-editor-path-modal');
                modal.setAttribute('role', 'dialog');
                modal.setAttribute('aria-modal', 'true');
            }

            const header = document.createElement('div');
            header.className = 'modal-header config-editor-header';

            const headerText = document.createElement('div');
            const titleEl = document.createElement('h3');
            titleEl.textContent = title;
            headerText.appendChild(titleEl);
            if (hasPathFields) {
                titleEl.id = `config-editor-title-${Math.random().toString(36).slice(2)}`;
                modal.setAttribute('aria-labelledby', titleEl.id);
            }
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
            const formId = `config-editor-form-${Math.random().toString(36).slice(2)}`;
            body.id = formId;

            const inputs = new Map();
            const pathStates = [];
            fields.forEach((field) => {
                const pathMode = isPathField(field);
                const input = field.multiline
                    ? document.createElement('textarea')
                    : document.createElement('input');
                input.id = `config-editor-${field.id}`;
                input.name = field.id;
                input.value = field.value || '';
                input.placeholder = field.placeholder || '';
                input.required = field.required !== false;
                if (!field.multiline) input.type = field.type || 'text';
                // Optional narrowing pattern; the submit handler checks it
                // against the trimmed value so a padded token still fails.
                if (field.pattern) input.pattern = field.pattern;
                if (field.monospace !== false)
                    input.classList.add('config-editor-mono');

                if (pathMode) {
                    const fieldRow = document.createElement('div');
                    fieldRow.className =
                        'config-editor-field config-editor-path-field';

                    const label = document.createElement('label');
                    label.className = 'config-editor-path-label';
                    label.htmlFor = input.id;
                    label.textContent = field.label;

                    const inputRow = document.createElement('div');
                    inputRow.className =
                        'path-input-row config-editor-path-row';
                    inputRow.appendChild(input);

                    const revealBtn = document.createElement('button');
                    revealBtn.className =
                        'btn btn-primary config-editor-path-reveal';
                    revealBtn.type = 'button';
                    revealBtn.textContent = 'Reveal';
                    inputRow.appendChild(revealBtn);

                    const status = document.createElement('div');
                    status.className = 'config-editor-path-status';
                    status.id = `${input.id}-path-status`;
                    status.setAttribute('role', 'status');
                    status.setAttribute('aria-live', 'polite');
                    input.setAttribute('aria-describedby', status.id);

                    const treeHost = document.createElement('div');
                    treeHost.className = 'config-editor-path-tree';

                    fieldRow.append(label, inputRow, status, treeHost);
                    body.appendChild(fieldRow);
                    pathStates.push({
                        input,
                        revealBtn,
                        status,
                        treeHost,
                        path: {
                            startPath: field.path.startPath,
                            relativeTo: field.path.relativeTo,
                        },
                        operation: 0,
                        composing: false,
                        controller: null,
                    });
                } else {
                    const row = document.createElement('label');
                    row.className = 'config-editor-field';
                    row.htmlFor = input.id;

                    const label = document.createElement('span');
                    label.textContent = field.label;
                    row.appendChild(label);
                    row.appendChild(input);
                    body.appendChild(row);
                }

                inputs.set(field.id, input);
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
                for (const state of pathStates) {
                    state.operation++;
                    state.controller?.destroy();
                    state.controller = null;
                }
                document.removeEventListener(
                    'keydown',
                    onKeydown,
                    hasPathFields,
                );
                if (hasPathFields) {
                    document.removeEventListener('focusin', onFocusin, true);
                }
                overlay.classList.add('hidden');
                overlay.remove();
                if (opener?.isConnected) opener.focus({ preventScroll: true });
                resolve(value);
            };

            const onKeydown = (event) => {
                if (event.key === 'Escape') {
                    if (hasPathFields) {
                        event.preventDefault();
                        event.stopPropagation();
                    }
                    cleanup(null);
                    return;
                }
                if (!hasPathFields || event.key !== 'Tab') return;

                const focusable = Array.from(
                    modal.querySelectorAll(
                        'button, input, textarea, select, [tabindex="0"]',
                    ),
                ).filter(
                    (element) =>
                        !element.disabled &&
                        !element.hidden &&
                        !element.closest('[hidden], .hidden'),
                );
                if (focusable.length === 0) {
                    event.preventDefault();
                    return;
                }
                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                const activeIndex = focusable.indexOf(
                    document.activeElement,
                );
                if (event.shiftKey && activeIndex <= 0) {
                    event.preventDefault();
                    last.focus({ preventScroll: true });
                } else if (
                    !event.shiftKey &&
                    (activeIndex < 0 || activeIndex === focusable.length - 1)
                ) {
                    event.preventDefault();
                    first.focus({ preventScroll: true });
                }
            };

            const onFocusin = (event) => {
                if (
                    settled ||
                    overlay.classList.contains('hidden') ||
                    !(event.target instanceof Node) ||
                    modal.contains(event.target)
                ) {
                    return;
                }
                pathStates[0]?.input.focus({ preventScroll: true });
            };

            const relativeRevealPath = (state, draft) => {
                if (
                    draft.startsWith('/') ||
                    draft.startsWith('\\\\') ||
                    /^[A-Za-z]:[\\/]/u.test(draft) ||
                    draft.startsWith('~')
                ) {
                    return draft;
                }
                const startPath = state.path.startPath;
                const base = startPath.replace(/\/+$/u, '');
                return `${base}/${draft}`;
            };

            const revealPath = async (state) => {
                const operation = ++state.operation;
                const draft = state.input.value.trim();
                state.status.textContent = '';
                const controller = state.controller;
                if (!draft) {
                    controller?.invalidateDraft();
                    state.status.textContent =
                        'Enter a directory path to reveal.';
                    return;
                }
                if (!controller) return;

                try {
                    const resolved = await controller.reveal(
                        relativeRevealPath(state, draft),
                    );
                    if (
                        settled ||
                        !overlay.isConnected ||
                        operation !== state.operation ||
                        resolved === null
                    ) {
                        return;
                    }
                    state.input.value = formatPickedDir(
                        resolved,
                        state.path.relativeTo,
                    );
                    state.status.textContent = '';
                    state.input.focus({ preventScroll: true });
                } catch {
                    if (
                        !settled &&
                        overlay.isConnected &&
                        operation === state.operation
                    ) {
                        state.status.textContent =
                            'This path is not an accessible directory.';
                    }
                }
            };

            closeBtn.addEventListener('click', () => cleanup(null));
            cancelBtn.addEventListener('click', () => cleanup(null));
            // This editor contains unsaved user input. Do not close it when
            // the user clicks the backdrop; only the explicit controls or
            // Escape should discard the draft.
            body.addEventListener('submit', (event) => {
                event.preventDefault();
                const values = {};
                for (const [id, input] of inputs.entries()) {
                    const value = input.value.trim();
                    if (input.required && !value) {
                        input.focus();
                        return;
                    }
                    if (
                        input.pattern &&
                        !new RegExp(`^(?:${input.pattern})$`, 'u').test(value)
                    ) {
                        input.focus();
                        input.setAttribute('aria-invalid', 'true');
                        return;
                    }
                    input.removeAttribute('aria-invalid');
                    values[id] = value;
                }
                cleanup(values);
            });
            document.addEventListener('keydown', onKeydown, hasPathFields);
            if (hasPathFields) {
                document.addEventListener('focusin', onFocusin, true);
            }

            for (const state of pathStates) {
                state.input.addEventListener('compositionstart', () => {
                    state.composing = true;
                });
                state.input.addEventListener('compositionend', () => {
                    state.composing = false;
                });
                state.input.addEventListener('input', () => {
                    state.operation++;
                    state.status.textContent = '';
                    state.controller?.invalidateDraft();
                });
                state.input.addEventListener('keydown', (event) => {
                    if (
                        event.key !== 'Enter' ||
                        state.composing ||
                        event.isComposing ||
                        event.keyCode === 229
                    ) {
                        return;
                    }
                    event.preventDefault();
                    void revealPath(state);
                });
                state.revealBtn.addEventListener('click', () => {
                    void revealPath(state);
                });
            }

            for (const state of pathStates) {
                state.controller = mountDirectoryTree(state.treeHost, {
                    startPath: state.path.startPath,
                    onSelect: (selected) => {
                        if (settled || !overlay.isConnected) return;
                        state.operation++;
                        state.input.value = formatPickedDir(
                            selected,
                            state.path.relativeTo,
                        );
                        state.status.textContent = '';
                    },
                });
            }

            requestAnimationFrame(() => {
                if (settled || !overlay.isConnected) return;
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
            const activeTab = this.tabManager?.getActiveTab();
            if (activeTab?.paneId) {
                url += `?pane=${encodeURIComponent(activeTab.paneId)}`;
            }
            const res = await fetch(url);
            if (!res.ok) throw new Error('Failed to fetch remote clipboard');
            const data = await res.json();
            const text = data && typeof data.text === 'string' ? data.text : '';
            const empty = data && data.empty === true;

            if (!empty && text.length > 0) {
                if (navigator.clipboard?.writeText) {
                    await navigator.clipboard.writeText(text);
                } else {
                    // Fallback to classic execCommand method for insecure contexts (e.g. remoting via local HTTP IP address)
                    const textArea = document.createElement('textarea');
                    textArea.value = text;
                    textArea.style.position = 'fixed';
                    textArea.style.top = '0';
                    textArea.style.left = '0';
                    textArea.style.opacity = '0';
                    document.body.appendChild(textArea);
                    textArea.focus();
                    textArea.select();
                    try {
                        const success = document.execCommand('copy');
                        if (!success)
                            throw new Error('execCommand copy returned false');
                    } finally {
                        document.body.removeChild(textArea);
                    }
                }
                console.log(
                    '[clipboard] Synced from',
                    data.source || '?',
                    'len=',
                    text.length,
                );

                if (btn) {
                    btn.classList.add('success');
                    const span = btn.querySelector('span');
                    const origText = span.innerText;
                    span.innerText = 'Synced!';
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
                console.log(
                    '[clipboard] nothing to sync (source=',
                    data.source || '?',
                    ')',
                );
                this.showToast(
                    data.source === 'shim'
                        ? 'Active session clipboard is empty'
                        : 'Remote clipboard is empty',
                    { type: 'info', title: 'Clipboard' },
                );
                if (btn) {
                    btn.classList.add('error');
                    const span = btn.querySelector('span');
                    const origText = span.innerText;
                    span.innerText = 'Empty';
                    setTimeout(() => {
                        btn.classList.remove('error');
                        span.innerText = origText;
                    }, 1500);
                }
            }
        } catch (e) {
            console.error('[clipboard] Sync error:', e);
            if (btn) {
                btn.classList.add('error');
                const span = btn.querySelector('span');
                const origText = span.innerText;
                span.innerText = 'Failed!';
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
            // Safari only honours a clipboard write that is *initiated* in the
            // same task as the click that triggered it. Awaiting the fetch
            // first spends the transient user activation, so the writeText()
            // that followed failed with NotAllowedError -- which is why copy
            // worked in Chrome but silently did nothing on macOS.
            //
            // ClipboardItem accepts a Promise for exactly this situation: the
            // write is registered synchronously while the activation is still
            // live, and the data is attached when it resolves.
            const configPromise = fetch(url).then(async (res) => {
                if (!res.ok) throw new Error('Failed to export config');
                const payload = await res.json();
                if (!payload.config) throw new Error('Failed to export config');
                return payload.config;
            });

            let copied = false;
            if (
                typeof ClipboardItem !== 'undefined' &&
                navigator.clipboard &&
                navigator.clipboard.write
            ) {
                try {
                    await navigator.clipboard.write([
                        new ClipboardItem({
                            'text/plain': configPromise.then(
                                (text) =>
                                    new Blob([text], { type: 'text/plain' }),
                            ),
                        }),
                    ]);
                    copied = true;
                } catch (e) {
                    // Fall through to the older paths below. configPromise is
                    // reused rather than refetched, and if the failure was the
                    // fetch itself it surfaces when it is awaited.
                    console.warn(
                        '[config] ClipboardItem write failed, falling back',
                        e,
                    );
                }
            }

            const data = { config: await configPromise };

            if (data.config) {
                if (copied) {
                    // Already on the clipboard via ClipboardItem.
                } else if (navigator.clipboard?.writeText) {
                    await navigator.clipboard.writeText(data.config);
                } else {
                    const textArea = document.createElement('textarea');
                    textArea.value = data.config;
                    textArea.style.position = 'fixed';
                    textArea.style.top = '0';
                    textArea.style.left = '0';
                    textArea.style.opacity = '0';
                    document.body.appendChild(textArea);
                    textArea.focus();
                    textArea.select();
                    try {
                        const success = document.execCommand('copy');
                        if (!success)
                            throw new Error('execCommand copy failed');
                    } finally {
                        document.body.removeChild(textArea);
                    }
                }

                if (btnElement) {
                    btnElement.classList.add('success');
                    const span = btnElement.querySelector('span') || btnElement;
                    const origText = span.innerText || span.textContent;
                    if (span.innerText !== undefined) {
                        span.innerText = 'Copied!';
                    } else {
                        span.textContent = 'Copied!';
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
            console.error('[config] Export error:', e);
            if (btnElement) {
                btnElement.classList.add('error');
                const span = btnElement.querySelector('span') || btnElement;
                const origText = span.innerText || span.textContent;
                if (span.innerText !== undefined) {
                    span.innerText = 'Failed!';
                } else {
                    span.textContent = 'Failed!';
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
            // Cmds were split (quick vs terminal) with three accepted
            // prefixes; every other config has exactly one. Normalize so
            // the paste gate below accepts whatever the server accepts.
            const prefixes = Array.isArray(prefix) ? prefix : [prefix];
            const prefixHint = prefixes.map((p) => `${p}:`).join(' / ');

            const openPasteDialog = async () => {
                if (typeof this.openConfigEditor === 'function') {
                    const values = await this.openConfigEditor({
                        title: 'Paste config',
                        subtitle: `Paste a config string starting with ${prefixHint}`,
                        fields: [
                            {
                                id: 'config',
                                label: 'Config',
                                multiline: true,
                                placeholder: `${prefixes[0]}:...`,
                            },
                        ],
                        submitLabel: 'Import',
                    });
                    return values?.config || '';
                }
                return typeof prompt === 'function'
                    ? prompt(
                          `Paste your config string here (starts with ${prefixHint}):`,
                      ) || ''
                    : '';
            };

            let configText = '';
            if (navigator.clipboard?.readText) {
                try {
                    configText = (await navigator.clipboard.readText()) || '';
                } catch (e) {
                    console.warn(
                        '[config] Clipboard read blocked, falling back to paste dialog',
                        e,
                    );
                }
            }

            if (!configText?.trim()) {
                configText = await openPasteDialog();
            }

            if (!configText) {
                if (btnElement) btnElement.classList.remove('loading');
                return; // User cancelled or pasted empty string
            }

            configText = configText.trim();

            // Fallback for single quick command / array of commands JSON
            if (
                prefixes.includes('PHICMDS') &&
                (configText.startsWith('{') || configText.startsWith('['))
            ) {
                try {
                    const data = JSON.parse(configText);
                    const isValidSingle =
                        data &&
                        typeof data === 'object' &&
                        !Array.isArray(data) &&
                        data.name &&
                        data.command;
                    const isValidArray =
                        Array.isArray(data) &&
                        data.every(
                            (item) =>
                                item &&
                                typeof item === 'object' &&
                                item.name &&
                                item.command,
                        );

                    if (isValidSingle || isValidArray) {
                        if (isValidArray) {
                            const confirmOverwrite = confirm(
                                `Do you want to overwrite all your quick commands with these ${data.length} commands?`,
                            );
                            if (!confirmOverwrite) {
                                if (btnElement)
                                    btnElement.classList.remove('loading');
                                return;
                            }
                        }

                        const res = await fetch('/api/config/quick-commands', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(data),
                        });

                        if (!res.ok) {
                            const text = await res.text();
                            throw new Error(
                                text || 'Failed to import quick commands',
                            );
                        }

                        if (btnElement) {
                            btnElement.classList.add('success');
                            const span =
                                btnElement.querySelector('span') || btnElement;
                            const origText = span.innerText || span.textContent;
                            if (span.innerText !== undefined) {
                                span.innerText = 'Imported!';
                            } else {
                                span.textContent = 'Imported!';
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
                    console.warn(
                        '[config] Attempted to parse commands JSON but failed, falling back to prefix check',
                        e,
                    );
                }
            }

            if (!prefixes.some((p) => configText.startsWith(`${p}:`))) {
                throw new Error(
                    `Invalid format. Config must start with ${prefixHint}`,
                );
            }

            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ config: configText }),
            });

            if (!res.ok) {
                const text = await res.text();
                throw new Error(text || 'Failed to import config');
            }

            if (btnElement) {
                btnElement.classList.add('success');
                const span = btnElement.querySelector('span') || btnElement;
                const origText = span.innerText || span.textContent;
                if (span.innerText !== undefined) {
                    span.innerText = 'Imported!';
                } else {
                    span.textContent = 'Imported!';
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
            console.error('[config] Import error:', e);
            if (btnElement) {
                btnElement.classList.add('error');
                const span = btnElement.querySelector('span') || btnElement;
                const origText = span.innerText || span.textContent;
                if (span.innerText !== undefined) {
                    span.innerText = 'Failed!';
                } else {
                    span.textContent = 'Failed!';
                }
                alert(`Import failed: ${e.message}`);
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
        await this._doExportConfig(
            '/api/config/export',
            document.getElementById('header-export-btn'),
        );
    }

    async importConfig() {
        await this._doImportConfig(
            '/api/config/import',
            document.getElementById('header-import-btn'),
            'PHICONFIG',
            () => {
                location.reload(); // Reload to apply import changes
            },
        );
    }

    async exportModelsConfig(btnElement) {
        await this._doExportConfig('/api/config/export-models', btnElement);
    }

    async importModelsConfig(btnElement) {
        await this._doImportConfig(
            '/api/config/import-models',
            btnElement,
            'PHIMODELS',
            async () => {
                await this.sessionsManager.loadConfig();
            },
        );
    }

    // v0.7.16: cmds split into quick (sent to active PTY) vs terminal
    // (spawn new shell tabs). They were conflated under /export-cmds and
    // called "the same thing" because the button text was the same. They
    // are not the same thing. Two separate endpoints, two separate methods.
    async exportQuickCommandsConfig(btnElement) {
        await this._doExportConfig(
            '/api/config/export-quick-commands',
            btnElement,
        );
    }

    async exportTerminalCommandsConfig(btnElement) {
        await this._doExportConfig(
            '/api/config/export-terminal-commands',
            btnElement,
        );
    }

    async importCmdsConfig(btnElement) {
        // Mirrors the server's accepted set in handleConfigImportCmds:
        // fresh exports use the split prefixes, old ones the legacy.
        await this._doImportConfig(
            '/api/config/import-cmds',
            btnElement,
            ['PHIQUICKCMDS', 'PHITERMCMDS', 'PHICMDS'],
            async () => {
                await this.sessionsManager.loadConfig();
            },
        );
    }

    // ─── Fleet panel (Phase 6 / plan §3.4) ────────────────────────────
    // Polls /api/peers/status every 15s while the sidebar is visible.
    // The poller itself is server-side and runs unconditionally; the
    // client just renders the cached snapshot and skips HTTP round-trips
    // when the user isn't looking. This protects sleepy laptops from a
    // 2 GETs/15s/peer heartbeat (risk R9).
    startFleetPolling(scope = this.scope) {
        if (this._fleetPollTimer && this._fleetPollScope === scope) return; // idempotent

        if (this._fleetPollTimer) {
            clearInterval(this._fleetPollTimer);
            this._fleetPollTimer = null;
        }
        if (this.syncManager?.pollInterval) {
            clearInterval(this.syncManager.pollInterval);
            this.syncManager.pollInterval = null;
        }
        this._fleetPollScope = scope;

        const isSidebarVisible = () => {
            const sidebar = document.getElementById('sidebar-panel');
            if (!sidebar) return true;
            return getComputedStyle(sidebar).display !== 'none';
        };

        const poll = async () => {
            if (scope?.aborted) return;
            if (!isSidebarVisible()) return;
            try {
                const fetchFn =
                    scope && typeof scope.fetch === 'function'
                        ? (url, init) => scope.fetch(url, init)
                        : fetch;
                const res = await fetchFn('/api/peers/status');
                if (scope?.aborted) return;
                if (!res.ok) return;
                const statuses = await res.json();
                if (scope?.aborted) return;
                this.getActiveStore?.()?.responses?.set('/api/peers/status', JSON.stringify(statuses));
                this.renderFleetPanel(statuses);
            } catch (err) {
                if (err?.name === 'AbortError' || scope?.aborted) return;
                console.warn('[fleet] poll failed:', err);
            }
        };

        poll(); // immediate first poll
        this._fleetPollTimer = scope?.interval
            ? scope.interval(poll, 15000)
            : setInterval(poll, 15000);
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
                const busyHtml =
                    peer.busy_count > 0
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
                row.title = `${peer.url}\n${peer.tab_count} tabs · ${peer.busy_count} busy\nphi ${peer.version || 'unknown'}\nidle ${peer.idle_min < 0 ? '?' : `${peer.idle_min}m`}`;
                row.addEventListener('click', () => {
                    if (peer.url) window.open(peer.url, '_blank', 'noopener');
                });
            } else {
                row.title = `${peer.url}\nunreachable${peer.error ? `: ${peer.error}` : ''}`;
                row.disabled = true;
            }

            list.appendChild(row);
        }

        if (badge) {
            badge.style.display = anyAttention ? '' : 'none';
        }
    }

    applyVersionData(data, { checkUpdate = true, scope = this.scope } = {}) {
        if (!data || typeof data !== 'object') return;
        this.versionInfo = data;
        // Pane IDs survive a server restart. Keep browser-local
        // order, selection, and drafts for the restored live tabs.
        if (data.started_at) {
            localStorage.setItem(
                serverKey('phi_server_started_at'),
                data.started_at,
            );
        }
        const changelogBtn =
            document.getElementById('phi-changelog-btn');
        if (changelogBtn) {
            // Only overwrite the HTML default when the binary reports
            // a real version (i.e. a stamped release build). A
            // `go run` / `go build` without ldflags reports "dev" -
            // in that case we keep whatever the HTML shipped, which
            // is the most recent release tag. The button always shows
            // something useful instead of flashing "dev".
            const ver = data.version;
            if (ver && ver !== 'dev') {
                changelogBtn.textContent = ver.startsWith('v')
                    ? ver
                    : `v${ver}`;
            }
        }
        // Once we know the install method, kick off the update check
        // (server-side throttled; this is just the UI hookup).
        if (checkUpdate) {
            this.checkForUpdate(scope);
        }
    }

    async loadVersion(scope) {
        try {
            const store = this.getActiveStore?.();
            if (store && typeof store.load === 'function') {
                await store.load('/api/version', scope, (data, { stale }) => {
                    this.applyVersionData(data, { checkUpdate: !stale, scope });
                });
            } else {
                const fetchFn =
                    scope && typeof scope.fetch === 'function'
                        ? (url, init) => scope.fetch(url, init)
                        : fetch;
                const res = await fetchFn('/api/version');
                if (scope?.aborted) return;
                if (res.ok) {
                    const data = await res.json();
                    if (scope?.aborted) return;
                    this.applyVersionData(data, { checkUpdate: true, scope });
                }
            }
        } catch (err) {
            if (err?.name === 'AbortError' || scope?.aborted) return;
            console.error('Failed to load version:', err);
        }
    }

    // checkForUpdate — Phase 7 T1 (plan §3.5). Polls /api/update/status;
    // if update_available, adds a subtle dot to the version pill + stashes
    // the full status on this.updateStatus for the popup. Throttled by
    // the server (24h ticker + 6h floor) so this is cheap to call.
    async checkForUpdate(scope) {
        try {
            const fetchFn =
                scope && typeof scope.fetch === 'function'
                    ? (url, init) => scope.fetch(url, init)
                    : fetch;
            const res = await fetchFn('/api/update/status');
            if (scope?.aborted) return;
            if (!res.ok) return;
            const data = await res.json();
            if (scope?.aborted) return;
            this.updateStatus = data;
            this.renderUpdateBadge(data);
        } catch (err) {
            if (err?.name === 'AbortError' || scope?.aborted) return;
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
    if (document.documentElement.hasAttribute('data-phi-config-page')) return;
    try {
        const scope = captureAppearanceScope();
        const auth = await bootstrapAccessAuth(appearanceRequestContext(scope));
        const app = new App(scope);
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
        detail.textContent =
            err instanceof Error
                ? err.message
                : 'Access protection could not start';
        dialog.append(title, detail);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
    }
});
