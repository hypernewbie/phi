/* Φ phi — Central Client Coordinator */

import { TabManager } from './terminal.js';
import { SessionsManager } from './sessions.js';
import { DiffController } from './diff.js';

class App {
    constructor() {
        this.codersPresetRegistry = {};
        
        // Instantiate controllers
        this.tabManager = new TabManager(this);
        this.sessionsManager = new SessionsManager(this);
        this.diffController = new DiffController(this);
    }
    
    async init() {
        // 1. Fetch coder templates & presets from API
        await this.fetchCoderPresets();
        
        // 2. Load workspace selector and configurations
        await this.sessionsManager.loadConfig();
        
        // 3. Setup panel resize handles
        this.initResizers();
        
        // 4. Initialize Diff terminal engine
        this.diffController.initTerminal();
        
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
}

// Start Application on DOM Load
window.addEventListener('DOMContentLoaded', () => {
    const app = new App();
    app.init();
});
