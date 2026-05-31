import { TabManager } from './terminal.js';
import { SessionsManager } from './sessions.js';
import { DiffController } from './diff.js';

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
}

// Start Application on DOM Load
window.addEventListener('DOMContentLoaded', () => {
    const app = new App();
    app.init();
});
