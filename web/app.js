import { TabManager } from './terminal.js';
import { SessionsManager } from './sessions.js';
import { DiffController } from './diff.js';
import { MarkdownManager } from './markdown.js';

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
    }
    
    async init() {
        // 1. Fetch coder templates & presets from API
        await this.fetchCoderPresets();
        
        // 2. Restore previously open terminal tabs (reconnects live PTY sessions)
        this.tabManager.restoreTabsState();

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

        // 8. Setup clipboard sync listener
        const clipboardBtn = document.getElementById('header-clipboard-btn');
        if (clipboardBtn) {
            clipboardBtn.addEventListener('click', async () => {
                await this.syncRemoteClipboard();
            });
        }
        
        console.log("[app] Phi initialized successfully");
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
        if (savedLeftWidth) sidebar.style.width = savedLeftWidth + 'px';
        if (savedRightWidth) diffPanel.style.width = savedRightWidth + 'px';

        // Left resizing handler
        leftHandle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            leftHandle.classList.add('dragging');
            document.body.style.cursor = 'col-resize';

            const doDrag = (moveEvent) => {
                const width = moveEvent.clientX - layout.getBoundingClientRect().left;
                if (width > 180 && width < 450) {
                    sidebar.style.width = width + 'px';
                    localStorage.setItem('phi_panel_left_width', width);
                    this.tabManager.fitActiveTerminal();
                }
            };

            const stopDrag = () => {
                leftHandle.classList.remove('dragging');
                document.body.style.cursor = '';
                document.removeEventListener('mousemove', doDrag);
                document.removeEventListener('mouseup', stopDrag);
                this.tabManager.fitActiveTerminal();
            };

            document.addEventListener('mousemove', doDrag);
            document.addEventListener('mouseup', stopDrag);
        });

        // Right resizing handler
        rightHandle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            rightHandle.classList.add('dragging');
            document.body.style.cursor = 'col-resize';

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
        let link = document.querySelector("link[rel~='icon']");
        if (!link) {
            link = document.createElement('link');
            link.rel = 'icon';
            link.type = 'image/svg+xml';
            document.getElementsByTagName('head')[0].appendChild(link);
        }
        
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

        let dismissTimer;
        const dismiss = () => {
            if (dismissTimer) clearTimeout(dismissTimer);
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 200);
        };
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
            const res = await fetch('/api/clipboard');
            if (!res.ok) throw new Error("Failed to fetch remote clipboard");
            const data = await res.json();
            if (data.text !== undefined) {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    await navigator.clipboard.writeText(data.text);
                } else {
                    // Fallback to classic execCommand method for insecure contexts (e.g. remoting via local HTTP IP address)
                    const textArea = document.createElement("textarea");
                    textArea.value = data.text;
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
                console.log("[clipboard] Successfully synced remote clipboard content:", data.text);
                
                // Provide visual feedback with a brief success state
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
}

// Start Application on DOM Load
window.addEventListener('DOMContentLoaded', () => {
    const app = new App();
    app.init();
});
